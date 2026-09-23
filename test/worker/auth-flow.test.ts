// 認證流程整合測試 —— 不 mock（vitest-pool-workers 不支援 vi.mock），
// 改用軟體 WebAuthn 認證器產生真實 attestation/assertion，
// 讓 @simplewebauthn/server 在 workerd 內完整驗證密碼學路徑。
// 注意：pool-workers 的 isolatedStorage 會在每個 it() 結束時回滾 D1，
// 因此整段註冊→登入→管理旅程必須在單一測試內完成。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { totpCode } from '../../src/worker/auth/totp';
import { createAuthenticator, type SoftAuthenticator } from './helpers/softauthn';

const ORIGIN = 'https://mail.miseroda.com';
const RP_ID = 'mail.miseroda.com';
const BASE = `${ORIGIN}/api/v1`;

interface Cookies {
  session?: string;
  csrf?: string;
}

function readCookies(res: Response, into: Cookies = {}): Cookies {
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const value = decodeURIComponent(pair.slice(eq + 1));
    if (name === '__Host-session') into.session = value;
    if (name === '__Host-csrf') into.csrf = value;
  }
  return into;
}

let ipCounter = 0;

async function call(
  path: string,
  opts: { method?: string; body?: unknown; cookies?: Cookies; headers?: Record<string, string> } = {},
): Promise<Response> {
  // 每次換 IP，避免觸發 per-IP 限流（限流行為由 hardening.test 專測）
  ipCounter += 1;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': `10.7.${Math.floor(ipCounter / 200)}.${ipCounter % 200}`,
    ...opts.headers,
  };
  if (opts.cookies?.session) {
    headers['Cookie'] = `__Host-session=${encodeURIComponent(opts.cookies.session)}; __Host-csrf=${encodeURIComponent(opts.cookies.csrf ?? '')}`;
    if (opts.cookies.csrf && !headers['X-CSRF-Token']) headers['X-CSRF-Token'] = opts.cookies.csrf;
  }
  const ctx = createExecutionContext();
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    ctx,
  );
}

/** 完整 passkey 登入（軟體認證器），回傳 verify response */
async function passkeyLogin(email: string, authn: SoftAuthenticator): Promise<Response> {
  const optRes = await call('/auth/login/options', { body: { email } });
  expect(optRes.status).toBe(200);
  const { challengeId, options } = await optRes.json<{ challengeId: string; options: { challenge: string } }>();
  const response = await authn.authenticate({ challenge: options.challenge }, ORIGIN, RP_ID);
  return call('/auth/login/verify', { body: { challengeId, response } });
}

describe('auth flow', () => {
  it('end-to-end: bootstrap → invite → passkey → TOTP → login → admin', async () => {
    const admin: Cookies = {};
    const user2: Cookies = {};
    const adminAuthn = await createAuthenticator();
    const kaiAuthn = await createAuthenticator();

    /* ---- bootstrap ---- */
    const badToken = await call('/auth/bootstrap', { body: { token: 'wrong', email: 'hon@miseroda.com' } });
    expect(badToken.status).toBe(403);

    const badEmail = await call('/auth/bootstrap', {
      body: { token: 'test-bootstrap-token', email: 'x@gmail.com' },
    });
    expect(badEmail.status).toBe(400);

    const bootRes = await call('/auth/bootstrap', {
      body: { token: 'test-bootstrap-token', email: 'hon@miseroda.com' },
    });
    expect(bootRes.status).toBe(200);
    const { code: inviteCode } = await bootRes.json<{ code: string }>();

    /* ---- 邀請碼檢查 ---- */
    const checkRes = await call('/auth/invite/check', { body: { code: inviteCode } });
    expect(checkRes.status).toBe(200);
    const checkBody = await checkRes.json<{ email: string; role: string }>();
    expect(checkBody.email).toBe('hon@miseroda.com');
    expect(checkBody.role).toBe('admin');

    const badInvite = await call('/auth/invite/check', { body: { code: 'XXXX-XXXX-XXXX' } });
    expect(badInvite.status).toBe(404);

    /* ---- 邀請註冊：真實 passkey ceremony ---- */
    const regOptRes = await call('/auth/register/options', { body: { code: inviteCode } });
    expect(regOptRes.status).toBe(200);
    const regOpt = await regOptRes.json<{
      challengeId: string;
      options: { challenge: string; authenticatorSelection?: { authenticatorAttachment?: string } };
    }>();
    expect(regOpt.options.challenge).toBeTruthy();
    // 首次註冊優先本機驗證器（Windows Hello / Touch ID）
    expect(regOpt.options.authenticatorSelection?.authenticatorAttachment).toBe('platform');

    const regResponse = await adminAuthn.register({ challenge: regOpt.options.challenge }, ORIGIN, RP_ID);
    const regVerRes = await call('/auth/register/verify', {
      body: { code: inviteCode, challengeId: regOpt.challengeId, response: regResponse },
    });
    expect(regVerRes.status).toBe(200);
    const regVerBody = await regVerRes.json<{ ok: boolean; totpSetupRequired: boolean }>();
    expect(regVerBody.totpSetupRequired).toBe(true);
    readCookies(regVerRes, admin);
    expect(admin.session).toBeTruthy();
    expect(admin.csrf).toBeTruthy();

    // 邀請已消耗；bootstrap 已關閉
    const reuse = await call('/auth/register/options', { body: { code: inviteCode } });
    expect(reuse.status).toBe(404);
    const bootAgain = await call('/auth/bootstrap', {
      body: { token: 'test-bootstrap-token', email: 'other@miseroda.com' },
    });
    expect(bootAgain.status).toBe(410);

    /* ---- /auth/me ---- */
    const meRes = await call('/auth/me', { method: 'GET', cookies: admin });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json<{ user: { email: string; role: string }; totpEnabled: boolean }>();
    expect(meBody.user.email).toBe('hon@miseroda.com');
    expect(meBody.user.role).toBe('admin');
    expect(meBody.totpEnabled).toBe(false);

    const noAuth = await call('/auth/me', { method: 'GET' });
    expect(noAuth.status).toBe(401);

    /* ---- CSRF / Origin 防護 ---- */
    const csrfBad = await call('/auth/totp/setup', {
      cookies: admin,
      headers: { 'X-CSRF-Token': 'nope' },
    });
    expect(csrfBad.status).toBe(403);

    const originBad = await call('/auth/totp/setup', {
      cookies: admin,
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(originBad.status).toBe(403);

    /* ---- TOTP 設定 + 備援碼 ---- */
    const setupRes = await call('/auth/totp/setup', { cookies: admin });
    expect(setupRes.status).toBe(200);
    const { secret, otpauth } = await setupRes.json<{ secret: string; otpauth: string }>();
    expect(otpauth).toContain('otpauth://totp/');

    const wrongCode = await call('/auth/totp/verify', { cookies: admin, body: { code: '000000' } });
    expect(wrongCode.status).toBe(400);

    const enableRes = await call('/auth/totp/verify', {
      cookies: admin,
      body: { code: await totpCode(secret, Date.now()) },
    });
    expect(enableRes.status).toBe(200);
    const { backupCodes } = await enableRes.json<{ backupCodes: string[] }>();
    expect(backupCodes).toHaveLength(8);

    /* ---- 登入需要 TOTP 第二步 ---- */
    const login1 = await passkeyLogin('hon@miseroda.com', adminAuthn);
    expect(login1.status).toBe(200);
    const login1Body = await login1.json<{ totpRequired?: boolean; totpToken?: string }>();
    expect(login1Body.totpRequired).toBe(true);

    const totpBad = await call('/auth/totp/challenge', {
      body: { totpToken: login1Body.totpToken, code: '000000' },
    });
    expect(totpBad.status).toBe(400);

    const totpOk = await call('/auth/totp/challenge', {
      body: { totpToken: login1Body.totpToken, code: await totpCode(secret, Date.now()) },
    });
    expect(totpOk.status).toBe(200);
    expect(readCookies(totpOk).session).toBeTruthy();

    /* ---- 備援碼當第二因子，單次有效 ---- */
    const login2 = await passkeyLogin('hon@miseroda.com', adminAuthn);
    const { totpToken: tk1 } = await login2.json<{ totpToken: string }>();
    const backupOk = await call('/auth/totp/challenge', { body: { totpToken: tk1, code: backupCodes[0] } });
    expect(backupOk.status).toBe(200);

    const login3 = await passkeyLogin('hon@miseroda.com', adminAuthn);
    const { totpToken: tk2 } = await login3.json<{ totpToken: string }>();
    const backupReuse = await call('/auth/totp/challenge', { body: { totpToken: tk2, code: backupCodes[0] } });
    expect(backupReuse.status).toBe(400);

    /* ---- challenge 單次有效（重放拒絕） ---- */
    const replayOptRes = await call('/auth/login/options', { body: { email: 'hon@miseroda.com' } });
    const replayOpt = await replayOptRes.json<{ challengeId: string; options: { challenge: string } }>();
    const replayResp = await adminAuthn.authenticate({ challenge: replayOpt.options.challenge }, ORIGIN, RP_ID);
    const first = await call('/auth/login/verify', {
      body: { challengeId: replayOpt.challengeId, response: replayResp },
    });
    expect(first.status).toBe(200);
    const replay = await call('/auth/login/verify', {
      body: { challengeId: replayOpt.challengeId, response: replayResp },
    });
    expect(replay.status).toBe(400);

    /* ---- 不存在帳號不洩漏（仍回 options） ---- */
    const ghostRes = await call('/auth/login/options', { body: { email: 'ghost@miseroda.com' } });
    expect(ghostRes.status).toBe(200);
    const ghostBody = await ghostRes.json<{ options: { challenge: string } }>();
    expect(ghostBody.options.challenge).toBeTruthy();

    /* ---- admin 邀請第二位使用者；權限隔離 ---- */
    const invRes = await call('/admin/invites', {
      cookies: admin,
      body: { email: 'kai@miseroda.com', role: 'user' },
    });
    expect(invRes.status).toBe(200);
    const { code: kaiCode } = await invRes.json<{ code: string }>();

    const kaiOptRes = await call('/auth/register/options', { body: { code: kaiCode } });
    const kaiOpt = await kaiOptRes.json<{ challengeId: string; options: { challenge: string } }>();
    const kaiResp = await kaiAuthn.register({ challenge: kaiOpt.options.challenge }, ORIGIN, RP_ID);
    const kaiVerRes = await call('/auth/register/verify', {
      body: { code: kaiCode, challengeId: kaiOpt.challengeId, response: kaiResp },
    });
    expect(kaiVerRes.status).toBe(200);
    readCookies(kaiVerRes, user2);

    const forbidden = await call('/admin/users', { method: 'GET', cookies: user2 });
    expect(forbidden.status).toBe(403);

    const usersRes = await call('/admin/users', { method: 'GET', cookies: admin });
    expect(usersRes.status).toBe(200);
    const usersBody = await usersRes.json<{ users: { id: string; email: string }[] }>();
    expect(usersBody.users.map((u) => u.email).sort()).toEqual(['hon@miseroda.com', 'kai@miseroda.com']);

    /* ---- 無 TOTP 的使用者：passkey 直接登入 ---- */
    const kaiLogin = await passkeyLogin('kai@miseroda.com', kaiAuthn);
    expect(kaiLogin.status).toBe(200);
    const kaiLoginBody = await kaiLogin.json<{ ok?: boolean; totpSetupRequired?: boolean }>();
    expect(kaiLoginBody.ok).toBe(true);
    expect(kaiLoginBody.totpSetupRequired).toBe(true);

    /* ---- admin 停用使用者 → 其 session 即死 ---- */
    const kai = usersBody.users.find((u) => u.email === 'kai@miseroda.com')!;
    const disableRes = await call(`/admin/users/${kai.id}`, {
      method: 'PATCH',
      cookies: admin,
      body: { status: 'disabled' },
    });
    expect(disableRes.status).toBe(200);

    const kaiMe = await call('/auth/me', { method: 'GET', cookies: user2 });
    expect(kaiMe.status).toBe(401);

    /* ---- 登出撤銷 session ---- */
    const logoutRes = await call('/auth/logout', { cookies: admin });
    expect(logoutRes.status).toBe(200);
    const meAfter = await call('/auth/me', { method: 'GET', cookies: admin });
    expect(meAfter.status).toBe(401);
  });
});
