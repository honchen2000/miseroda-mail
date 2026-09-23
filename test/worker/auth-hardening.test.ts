// Codex 對抗式審查 Round 1 修復：TOTP 嘗試上限原子化 + passkey 刪除原子守門。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { createAuthenticator } from './helpers/softauthn';
import { seedUser } from './helpers/fixtures';

const ORIGIN = 'https://mail.miseroda.com';
const RP_ID = 'mail.miseroda.com';
const BASE = `${ORIGIN}/api/v1`;

let ipc = 0;
async function call(path: string, opts: { method?: string; body?: unknown; cookies?: { session: string; csrf: string } } = {}): Promise<Response> {
  ipc += 1;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.5.${Math.floor(ipc / 200)}.${ipc % 200}` };
  if (opts.cookies) {
    headers['Cookie'] = `__Host-session=${encodeURIComponent(opts.cookies.session)}; __Host-csrf=${encodeURIComponent(opts.cookies.csrf)}`;
    headers['X-CSRF-Token'] = opts.cookies.csrf;
  }
  return worker.fetch(new Request(`${BASE}${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }), env, createExecutionContext());
}

describe('auth hardening (Codex round 1)', () => {
  it('TOTP 第二步：5 次錯誤後第 6 次回 429（CAS 原子計數，上限不被繞過）', async () => {
    const u = await seedUser(env, 'u@miseroda.com'); // TOTP 已啟用
    const now = Date.now();
    // 直接種一張 totp_login challenge（totpToken = challenge id，明碼）
    await env.DB.prepare(`INSERT INTO challenges (id, user_id, type, value, created_at, expires_at) VALUES ('totptok', ?, 'totp_login', ?, ?, ?)`)
      .bind(u.userId, JSON.stringify({ attempts: 0 }), now, now + 300_000)
      .run();
    // 用非 6 位數輸入走備援碼路徑（不需解 TOTP 種子）；全錯
    for (let i = 0; i < 5; i++) {
      const r = await call('/auth/totp/challenge', { body: { totpToken: 'totptok', code: `wrong-${i}` } });
      expect(r.status).toBe(400);
      expect((await r.json<{ error: string; attemptsLeft: number }>()).attemptsLeft).toBe(5 - i - 1);
    }
    // 第 6 次 → 429
    expect((await call('/auth/totp/challenge', { body: { totpToken: 'totptok', code: 'wrong-x' } })).status).toBe(429);
  });

  it('刪 passkey：擋下最後一把（last_passkey）、不存在 404、非最後一把可刪', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    const u = await seedUser(env, 'u@miseroda.com');
    const bind = async () => {
      const authn = await createAuthenticator();
      const token = (await (await call(`/admin/users/${u.userId}/recovery`, { method: 'POST', body: {}, cookies: admin.cookies })).json<{ token: string }>()).token;
      const opt = await (await call('/auth/recover/options', { body: { token } })).json<{ challengeId: string; options: { challenge: string } }>();
      const response = await authn.register({ challenge: opt.options.challenge }, ORIGIN, RP_ID);
      await call('/auth/recover/verify', { body: { token, challengeId: opt.challengeId, response } });
    };
    await bind(); // 第 1 把
    const cred1 = (await env.DB.prepare(`SELECT id FROM credentials WHERE user_id = ? LIMIT 1`).bind(u.userId).first<{ id: string }>())!.id;

    // 只有 1 把 → 刪它被擋
    expect((await call(`/auth/passkeys/${cred1}`, { method: 'DELETE', cookies: u.cookies })).status).toBe(400);
    // 不存在 → 404
    expect((await call('/auth/passkeys/cred_nope', { method: 'DELETE', cookies: u.cookies })).status).toBe(404);

    await bind(); // 第 2 把 → 現在 2 把
    expect((await call(`/auth/passkeys/${cred1}`, { method: 'DELETE', cookies: u.cookies })).status).toBe(200); // 非最後一把可刪
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?`).bind(u.userId).first<{ n: number }>().then((r) => r!.n)).toBe(1);
    // 剩 1 把 → 再刪被擋
    const last = (await env.DB.prepare(`SELECT id FROM credentials WHERE user_id = ? LIMIT 1`).bind(u.userId).first<{ id: string }>())!.id;
    expect((await call(`/auth/passkeys/${last}`, { method: 'DELETE', cookies: u.cookies })).status).toBe(400);
  });
});
