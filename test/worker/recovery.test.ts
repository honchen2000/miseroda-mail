// passkey 救援流程：admin 核發 token → 既有帳號重新綁定新 passkey（真實 ceremony）。
// 涵蓋：核發授權、check/options/verify、單次、過期、跨人、非 admin、register email 衝突。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { createAuthenticator } from './helpers/softauthn';
import { seedUser } from './helpers/fixtures';
import { hashCode, sha256Hex } from '../../src/worker/lib/crypto';

const ORIGIN = 'https://mail.miseroda.com';
const RP_ID = 'mail.miseroda.com';
const BASE = `${ORIGIN}/api/v1`;

let ipc = 0;
async function call(
  path: string,
  opts: { method?: string; body?: unknown; cookies?: { session: string; csrf: string } } = {},
): Promise<Response> {
  ipc += 1;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': `10.9.${Math.floor(ipc / 200)}.${ipc % 200}`,
  };
  if (opts.cookies) {
    headers['Cookie'] = `__Host-session=${encodeURIComponent(opts.cookies.session)}; __Host-csrf=${encodeURIComponent(opts.cookies.csrf)}`;
    headers['X-CSRF-Token'] = opts.cookies.csrf;
  }
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    createExecutionContext(),
  );
}

async function issueRecovery(adminCookies: { session: string; csrf: string }, userId: string) {
  const res = await call(`/admin/users/${userId}/recovery`, { method: 'POST', body: {}, cookies: adminCookies });
  return { status: res.status, body: await res.json<{ token?: string; email?: string; url?: string }>() };
}

describe('passkey recovery', () => {
  it('admin issues token → existing user re-binds a new passkey → can authenticate', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    const locked = await seedUser(env, 'locked@miseroda.com'); // active, TOTP on, 0 creds

    // 核發
    const iss = await issueRecovery(admin.cookies, locked.userId);
    expect(iss.status).toBe(200);
    const token = iss.body.token!;
    expect(token).toBeTruthy();
    expect(iss.body.url).toContain('#recover=');

    // check → 回 email
    const chk = await call('/auth/recover/check', { body: { token } });
    expect(chk.status).toBe(200);
    expect((await chk.json<{ email: string }>()).email).toBe('locked@miseroda.com');

    // options → 真實 ceremony → verify
    const authn = await createAuthenticator();
    const optRes = await call('/auth/recover/options', { body: { token } });
    expect(optRes.status).toBe(200);
    const opt = await optRes.json<{ challengeId: string; options: { challenge: string } }>();
    const response = await authn.register({ challenge: opt.options.challenge }, ORIGIN, RP_ID);
    const ver = await call('/auth/recover/verify', { body: { token, challengeId: opt.challengeId, response } });
    expect(ver.status).toBe(200);

    // 確實新增了一把 credential 給 locked
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?`).bind(locked.userId).first<{ n: number }>();
    expect(n!.n).toBe(1);

    // 新 passkey 真能登入（有 TOTP → 回 totpRequired，代表 passkey 這一關過了）
    const loginOpt = await call('/auth/login/options', { body: { email: 'locked@miseroda.com' } });
    const lo = await loginOpt.json<{ challengeId: string; options: { challenge: string } }>();
    const assertion = await authn.authenticate({ challenge: lo.options.challenge }, ORIGIN, RP_ID);
    const loginVer = await call('/auth/login/verify', { body: { challengeId: lo.challengeId, response: assertion } });
    expect(loginVer.status).toBe(200);
    expect((await loginVer.json<{ totpRequired?: boolean }>()).totpRequired).toBe(true);

    // 單次：同 token 再 options/verify → 已用 → invalid_token
    const reuse = await call('/auth/recover/options', { body: { token } });
    expect(reuse.status).toBe(404);
  });

  it('rejects non-admin issuance, expired token, and unknown token', async () => {
    const user = await seedUser(env, 'plain@miseroda.com'); // 非 admin
    const target = await seedUser(env, 'target@miseroda.com');

    // 非 admin 不能核發
    const forbidden = await call(`/admin/users/${target.userId}/recovery`, { method: 'POST', body: {}, cookies: user.cookies });
    expect(forbidden.status).toBe(403);

    // 未知 token
    expect((await call('/auth/recover/check', { body: { token: 'totally-bogus-token' } })).status).toBe(404);

    // 過期 token：核發後手動改 expires_at
    const admin = await seedUser(env, 'admin2@miseroda.com', 'admin');
    const iss = await issueRecovery(admin.cookies, target.userId);
    const token = iss.body.token!;
    await env.DB.prepare(`UPDATE recovery_tokens SET expires_at = ? WHERE user_id = ?`).bind(Date.now() - 1000, target.userId).run();
    expect((await call('/auth/recover/check', { body: { token } })).status).toBe(404);
  });

  it('issued token binds ONLY to its own user', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    const a = await seedUser(env, 'usera@miseroda.com');
    const b = await seedUser(env, 'userb@miseroda.com');
    const iss = await issueRecovery(admin.cookies, a.userId);
    const token = iss.body.token!;
    // check 回的是 a，不是 b
    expect((await (await call('/auth/recover/check', { body: { token } })).json<{ email: string }>()).email).toBe('usera@miseroda.com');
    // 用 token 綁定 → credential 落在 a，b 仍 0
    const authn = await createAuthenticator();
    const opt = await (await call('/auth/recover/options', { body: { token } })).json<{ challengeId: string; options: { challenge: string } }>();
    const response = await authn.register({ challenge: opt.options.challenge }, ORIGIN, RP_ID);
    expect((await call('/auth/recover/verify', { body: { token, challengeId: opt.challengeId, response } })).status).toBe(200);
    const bn = await env.DB.prepare(`SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?`).bind(b.userId).first<{ n: number }>();
    expect(bn!.n).toBe(0);
  });

  it('refuses recovery for a TOTP-less account (no surviving 2nd factor → token alone = takeover)', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    const noTotp = await seedUser(env, 'nototp@miseroda.com');
    await env.DB.prepare(`DELETE FROM totp_secrets WHERE user_id = ?`).bind(noTotp.userId).run(); // 模擬尚未完成兩步驟

    // admin 端擋下核發
    const iss = await call(`/admin/users/${noTotp.userId}/recovery`, { method: 'POST', body: {}, cookies: admin.cookies });
    expect(iss.status).toBe(409);
    expect((await iss.json<{ error: string }>()).error).toBe('totp_not_enabled');

    // 縱深：即使硬塞一張 token，/recover/check 也擋
    const raw = 'manual-injected-token-abc';
    await env.DB.prepare(
      `INSERT INTO recovery_tokens (id, user_id, token_hash, created_by, created_at, expires_at) VALUES ('rec_nt', ?, ?, NULL, ?, ?)`,
    )
      .bind(noTotp.userId, await sha256Hex(raw), Date.now(), Date.now() + 3600_000)
      .run();
    expect((await call('/auth/recover/check', { body: { token: raw } })).status).toBe(409);
  });

  it('register with an already-registered email is rejected (email_exists), not a 500', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    // admin 對既有 email 建邀請（繞過 admin /invites 的 user_exists 守門，直接塞一張）
    await env.DB.prepare(
      `INSERT INTO invites (id, code_hash, email, role, invited_by, created_at, expires_at)
       VALUES ('inv_dup', ?, 'hon@miseroda.com', 'user', ?, ?, ?)`,
    )
      .bind(await hashCode('DUPE-CODE-1234'), admin.userId, Date.now(), Date.now() + 3600_000)
      .run();
    const res = await call('/auth/register/options', { body: { code: 'DUPE-CODE-1234' } });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('email_exists');
  });
});
