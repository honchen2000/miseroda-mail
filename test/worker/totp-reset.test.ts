// admin 重設 TOTP（解「passkey 救援後仍卡 TOTP 且驗證器/備援碼皆失」死鎖）+ 自助重發備援碼。
// 安全要點：重設後清 2FA + 撤 session/trusted，passkey 登入改走免 TOTP 快路徑（強制重設）。
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
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.7.${Math.floor(ipc / 200)}.${ipc % 200}` };
  if (opts.cookies) {
    headers['Cookie'] = `__Host-session=${encodeURIComponent(opts.cookies.session)}; __Host-csrf=${encodeURIComponent(opts.cookies.csrf)}`;
    headers['X-CSRF-Token'] = opts.cookies.csrf;
  }
  return worker.fetch(
    new Request(`${BASE}${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }),
    env,
    createExecutionContext(),
  );
}
const count = async (sql: string, id: string) => (await env.DB.prepare(sql).bind(id).first<{ n: number }>())!.n;

describe('admin reset TOTP + regenerate backup codes', () => {
  it('重設清 TOTP/備援碼 + 撤 session；重設後 passkey 登入走免 TOTP 快路徑（強制重設）', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    const locked = await seedUser(env, 'locked@miseroda.com'); // TOTP on + session
    await env.DB.prepare(`INSERT INTO backup_codes (id, user_id, code_hash) VALUES ('bak_x', ?, 'h')`).bind(locked.userId).run();

    // 給 locked 一把 passkey（走救援綁定真實 ceremony）；名稱刻意帶換行 → 應被壓成單行後才存
    const authn = await createAuthenticator();
    const token = (await (await call(`/admin/users/${locked.userId}/recovery`, { method: 'POST', body: {}, cookies: admin.cookies })).json<{ token: string }>()).token;
    const opt = await (await call('/auth/recover/options', { body: { token } })).json<{ challengeId: string; options: { challenge: string } }>();
    const response = await authn.register({ challenge: opt.options.challenge }, ORIGIN, RP_ID);
    expect((await call('/auth/recover/verify', { body: { token, challengeId: opt.challengeId, response, name: '本人 iPhone\n（已由管理員確認）' } })).status).toBe(200);

    // 帳號有「救援連結綁定」的 passkey → 未承認的重設被擋下，且零寫入
    // （重設會拆掉 TOTP，那把 passkey 就能免 TOTP 登入並自行重設 TOTP＝完整接管；
    //   伺服器分不出是本人綁的還是攔截連結者綁的，只能請 admin 逐一承認）
    const blocked = await call(`/admin/users/${locked.userId}/totp/reset`, { method: 'POST', body: {}, cookies: admin.cookies });
    expect(blocked.status).toBe(409);
    const listed = await blocked.json<{ error: string; passkeys: { id: string; name: string | null }[] }>();
    expect(listed.error).toBe('recovery_passkeys_unconfirmed');
    expect(listed.passkeys).toHaveLength(1);
    expect(listed.passkeys[0].name).toBe('本人 iPhone （已由管理員確認）'); // 換行被壓成空白，不能偽造多行提示
    expect(await count(`SELECT COUNT(*) n FROM totp_secrets WHERE user_id = ?`, locked.userId)).toBe(1); // 零寫入
    expect(await count(`SELECT COUNT(*) n FROM backup_codes WHERE user_id = ?`, locked.userId)).toBe(1);

    // admin 逐一承認後才真的重設
    const reset = await call(`/admin/users/${locked.userId}/totp/reset`, {
      method: 'POST',
      body: { acknowledgeRecoveryPasskeys: listed.passkeys.map((p) => p.id) },
      cookies: admin.cookies,
    });
    expect(reset.status).toBe(200);

    // 2FA 全清
    expect(await count(`SELECT COUNT(*) n FROM totp_secrets WHERE user_id = ?`, locked.userId)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM backup_codes WHERE user_id = ?`, locked.userId)).toBe(0);
    // locked 既有 session 被撤
    const sess = await env.DB.prepare(`SELECT revoked_at FROM sessions WHERE user_id = ?`).bind(locked.userId).first<{ revoked_at: number | null }>();
    expect(sess?.revoked_at).not.toBeNull();

    // 重設後 passkey 登入 → totpSetupRequired（免 TOTP 快路徑），不再 totpRequired
    const lo = await (await call('/auth/login/options', { body: { email: 'locked@miseroda.com' } })).json<{ challengeId: string; options: { challenge: string } }>();
    const assertion = await authn.authenticate({ challenge: lo.options.challenge }, ORIGIN, RP_ID);
    const lv = await call('/auth/login/verify', { body: { challengeId: lo.challengeId, response: assertion } });
    expect(lv.status).toBe(200);
    const lvb = await lv.json<{ totpSetupRequired?: boolean; totpRequired?: boolean }>();
    expect(lvb.totpSetupRequired).toBe(true);
    expect(lvb.totpRequired).toBeUndefined();
  });

  it('admin 不能重設自己/其他 admin；非 admin 被擋；目標不存在 404', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    const admin2 = await seedUser(env, 'hon2@miseroda.com', 'admin');
    const user = await seedUser(env, 'u@miseroda.com');
    expect((await call(`/admin/users/${admin.userId}/totp/reset`, { method: 'POST', body: {}, cookies: admin.cookies })).status).toBe(400); // self
    expect((await call(`/admin/users/${admin2.userId}/totp/reset`, { method: 'POST', body: {}, cookies: admin.cookies })).status).toBe(403); // 另一 admin
    expect((await call(`/admin/users/${user.userId}/totp/reset`, { method: 'POST', body: {}, cookies: user.cookies })).status).toBe(403); // non-admin caller
    expect((await call(`/admin/users/usr_nope/totp/reset`, { method: 'POST', body: {}, cookies: admin.cookies })).status).toBe(404);
  });

  it('沒有救援綁定 passkey 的帳號：body {} 照舊直接重設（最常見的「只丟了驗證器」情境不受影響）', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    const u = await seedUser(env, 'plain@miseroda.com'); // TOTP on、passkey 非救援綁定
    await env.DB.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       VALUES ('cred_self', ?, 'pk', 0, '[]', 'multiDevice', 1, '自己加的手機', ?)`,
    ).bind(u.userId, Date.now()).run();
    const res = await call(`/admin/users/${u.userId}/totp/reset`, { method: 'POST', body: {}, cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(await count(`SELECT COUNT(*) n FROM totp_secrets WHERE user_id = ?`, u.userId)).toBe(0);
  });

  it('承認清單少一把就整批擋下（攔截救援連結綁的 passkey 不會被默默放行）；多送的 id 無效果', async () => {
    const admin = await seedUser(env, 'hon@miseroda.com', 'admin');
    const victim = await seedUser(env, 'victim@miseroda.com');
    // 兩把救援綁定：一把本人、一把攻擊者（名稱刻意模仿本人那把）
    for (const [id, name] of [['cred_owner', '本人 iPhone'], ['cred_evil', '本人 iPhone(2)']]) {
      await env.DB.prepare(
        `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at, recovery_bound)
         VALUES (?, ?, 'pk', 0, '[]', 'singleDevice', 0, ?, ?, 1)`,
      ).bind(id, victim.userId, name, Date.now()).run();
    }

    // 只承認一把 → 409，且 TOTP/session 完全沒動
    const partial = await call(`/admin/users/${victim.userId}/totp/reset`, {
      method: 'POST', body: { acknowledgeRecoveryPasskeys: ['cred_owner'] }, cookies: admin.cookies,
    });
    expect(partial.status).toBe(409);
    expect((await partial.json<{ passkeys: { id: string }[] }>()).passkeys.map((p) => p.id).sort()).toEqual(['cred_evil', 'cred_owner']);
    expect(await count(`SELECT COUNT(*) n FROM totp_secrets WHERE user_id = ?`, victim.userId)).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`, victim.userId)).toBe(1);

    // 兩把都承認（外加一個不存在的 id，應被忽略）→ 200
    const ok = await call(`/admin/users/${victim.userId}/totp/reset`, {
      method: 'POST', body: { acknowledgeRecoveryPasskeys: ['cred_owner', 'cred_evil', 'cred_gone'] }, cookies: admin.cookies,
    });
    expect(ok.status).toBe(200);
    expect(await count(`SELECT COUNT(*) n FROM totp_secrets WHERE user_id = ?`, victim.userId)).toBe(0);
    // 承認的名單入稽核紀錄（事後可回溯「重設當下誰能免 TOTP 登入」）
    const aud = await env.DB.prepare(`SELECT meta FROM audit_log WHERE action = 'admin.totp.reset' AND target_id = ?`)
      .bind(victim.userId)
      .first<{ meta: string }>();
    expect(JSON.parse(aud!.meta).acknowledgedRecoveryPasskeys.sort()).toEqual(['cred_evil', 'cred_owner']);
  });

  it('自助重發備援碼：8 組新碼、覆蓋舊碼；未啟用 TOTP → 409', async () => {
    const u = await seedUser(env, 'u@miseroda.com'); // TOTP on
    await env.DB.prepare(`INSERT INTO backup_codes (id, user_id, code_hash) VALUES ('bak_old', ?, 'old')`).bind(u.userId).run();
    const res = await call('/auth/backup-codes/regenerate', { method: 'POST', body: {}, cookies: u.cookies });
    expect(res.status).toBe(200);
    expect((await res.json<{ backupCodes: string[] }>()).backupCodes).toHaveLength(8);
    expect(await count(`SELECT COUNT(*) n FROM backup_codes WHERE user_id = ?`, u.userId)).toBe(8); // 舊的被覆蓋

    // 未啟用 TOTP 者被擋下：伺服器端 MFA 強制 guard 在路由前先回 403（逼去設定 TOTP），
    // 我端點內的 totp_not_enabled(409) 為縱深防禦、實務上 guard 先觸發。無論哪個都「擋住」。
    const noTotp = await seedUser(env, 'nt@miseroda.com');
    await env.DB.prepare(`DELETE FROM totp_secrets WHERE user_id = ?`).bind(noTotp.userId).run();
    expect([403, 409]).toContain((await call('/auth/backup-codes/regenerate', { method: 'POST', body: {}, cookies: noTotp.cookies })).status);
  });
});
