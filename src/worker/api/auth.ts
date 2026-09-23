import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { audit } from '../lib/audit';
import { newId } from '../lib/ids';
import { aesGcmDecrypt, aesGcmEncrypt, bufToB64url } from '../lib/crypto';
import {
  clearSessionCookies,
  cookieNames,
  createChallenge,
  createSession,
  createTrustedDevice,
  consumeChallenge,
  deleteChallenge,
  isTrustedDevice,
  parseCookies,
  peekChallenge,
  REGISTER_CHALLENGE_TTL_MS,
  revokeAllSessions,
  revokePushSubscriptionsForSession,
  revokePushSubscriptionsForUser,
  revokeSession,
  revokeTrustedDevices,
  type UserRow,
} from '../auth/sessions';
import { createInvite, findValidInvite, markInviteUsed } from '../auth/invites';
import { findValidRecoveryToken, markRecoveryUsed } from '../auth/recovery';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp';
import { consumeBackupCode, generateBackupCodes, remainingBackupCodes } from '../auth/backupCodes';
import { decoyCredentialIds } from '../auth/loginDecoy';
import {
  checkAuthentication,
  checkRegistration,
  makeAuthenticationOptions,
  makeRegistrationOptions,
  sanitizePasskeyName,
  type CredentialRow,
} from '../auth/webauthn';
import { getIp, getUa, isDomainEmail, requireSession, type Vars } from './middleware';
import { maybeNotifyNewDevice } from '../lib/knownDevice';
import { rateLimitMw } from '../lib/ratelimit';

const TOTP_MAX_ATTEMPTS = 5;

function setCookies(c: { header: (k: string, v: string, o?: { append: boolean }) => void }, cookies: string[]) {
  for (const v of cookies) c.header('Set-Cookie', v, { append: true });
}

export function authRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  // 認證敏感端點限流（per IP / 分鐘）
  for (const path of ['/bootstrap', '/invite/check', '/register/*', '/login/*', '/totp/challenge', '/recover/*', '/demo-login']) {
    app.use(path, rateLimitMw('auth', 15, 60));
  }

  /** 前端 RP ID 防呆 + Web Push 公鑰 */
  app.get('/config', (c) =>
    c.json({ rpId: c.env.RP_ID, domain: c.env.MAIL_DOMAIN, vapidPublicKey: c.env.VAPID_PUBLIC_KEY ?? null }),
  );

  /* ---------- 唯讀 demo 一鍵進場（求職招募方免註冊參觀）----------
     預設關閉：DEMO_USER_ID 未設定 → 404。
     縱深防禦：只有「status=active 且 is_demo=1」的帳號能被發 session——即使 DEMO_USER_ID 誤設成真帳號，
     也不會發出真帳號的 passwordless session。發出的 session 仍受 requireSession 的 demo_readonly 硬擋，寄不出信、動不了資料。 */
  app.post('/demo-login', async (c) => {
    const demoId = c.env.DEMO_USER_ID;
    if (!demoId) return c.json({ error: 'not_found' }, 404); // 功能關閉
    const user = await c.var.db.prepare(`SELECT id, is_demo FROM users WHERE id = ? AND status = 'active'`)
      .bind(demoId)
      .first<{ id: string; is_demo: number }>();
    if (!user || !user.is_demo) return c.json({ error: 'not_found' }, 404); // 目標非 active demo 帳號 → 拒發
    const session = await createSession(c.env, user.id, { ip: getIp(c), userAgent: getUa(c) });
    setCookies(c, session.cookies);
    await audit(c.var.db, { userId: user.id, action: 'auth.demo_login', ip: getIp(c), userAgent: getUa(c) });
    return c.json({ ok: true });
  });

  /* ---------- 首位 admin bootstrap（users 空 + BOOTSTRAP_TOKEN 才開） ---------- */
  app.post('/bootstrap', async (c) => {
    const body = z.object({ token: z.string().min(1), email: z.string().email() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    if (!c.env.BOOTSTRAP_TOKEN || body.data.token !== c.env.BOOTSTRAP_TOKEN) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const email = body.data.email.toLowerCase();
    if (!isDomainEmail(c.env, email)) return c.json({ error: 'email_not_in_domain' }, 400);
    const existing = await c.var.db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
    if ((existing?.n ?? 0) > 0) return c.json({ error: 'already_bootstrapped' }, 410);
    const invite = await createInvite(c.env, { email, role: 'admin', invitedBy: null });
    await audit(c.var.db, { action: 'auth.bootstrap', ip: getIp(c), userAgent: getUa(c), meta: { email } });
    return c.json({ code: invite.code, email, expiresAt: invite.expiresAt });
  });

  /* ---------- 邀請碼檢查（註冊第 0 步） ---------- */
  app.post('/invite/check', async (c) => {
    const body = z.object({ code: z.string().min(8) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const invite = await findValidInvite(c.env, body.data.code);
    if (!invite) return c.json({ error: 'invalid_invite' }, 404);
    return c.json({ email: invite.email, role: invite.role, expiresAt: invite.expires_at });
  });

  /* ---------- 邀請註冊：Passkey ---------- */
  app.post('/register/options', async (c) => {
    const body = z.object({ code: z.string().min(8) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const invite = await findValidInvite(c.env, body.data.code);
    if (!invite) return c.json({ error: 'invalid_invite' }, 404);
    // 既有信箱不能用「邀請註冊」重綁（會撞 users.email UNIQUE）→ 明確擋下並導向救援流程，
    // 不讓使用者白做一次 passkey ceremony、也不讓後面的 INSERT 噴 500。
    const dup = await c.var.db.prepare(`SELECT 1 AS x FROM users WHERE email = ?`).bind(invite.email).first();
    if (dup) return c.json({ error: 'email_exists' }, 409);

    // user id 此刻先佔位，verify 成功才落 users 列
    const userId = newId('usr');
    const userIdB64url = bufToB64url(new TextEncoder().encode(userId));
    const options = await makeRegistrationOptions(c.env, {
      userIdB64url,
      email: invite.email,
      excludeCredentialIds: [],
      // 首次註冊優先用本機驗證器（Windows Hello / Touch ID），避開 Google 密碼管理工具連線失敗
      authenticatorAttachment: 'platform',
    });
    const challengeId = await createChallenge(
      c.env,
      'webauthn_register',
      JSON.stringify({ challenge: options.challenge, inviteId: invite.id, userId }),
      null,
      REGISTER_CHALLENGE_TTL_MS,
    );
    return c.json({ challengeId, options });
  });

  app.post('/register/verify', async (c) => {
    const body = z
      .object({ code: z.string().min(8), challengeId: z.string(), response: z.custom<RegistrationResponseJSON>() })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const invite = await findValidInvite(c.env, body.data.code);
    if (!invite) return c.json({ error: 'invalid_invite' }, 404);
    const chal = await consumeChallenge(c.env, body.data.challengeId, 'webauthn_register');
    if (!chal) return c.json({ error: 'challenge_expired' }, 400);
    const { challenge, inviteId, userId } = JSON.parse(chal.value) as {
      challenge: string;
      inviteId: string;
      userId: string;
    };
    if (inviteId !== invite.id) return c.json({ error: 'invite_mismatch' }, 400);

    const reg = await checkRegistration(c.env, { response: body.data.response, expectedChallenge: challenge });
    if (!reg.ok) {
      await audit(c.var.db, {
        action: 'auth.register.fail',
        ip: getIp(c),
        userAgent: getUa(c),
        meta: { email: invite.email, reason: reg.reason },
      });
      return c.json({ error: 'verification_failed', reason: reg.reason }, 400);
    }

    // 邀請單次使用：原子標記，輸了表示已被用掉
    if (!(await markInviteUsed(c.env, invite.id))) return c.json({ error: 'invalid_invite' }, 404);

    const now = Date.now();
    const displayName = invite.email.split('@')[0];
    await c.var.db.batch([
      c.var.db.prepare(
        `INSERT INTO users (id, email, display_name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
      ).bind(userId, invite.email, displayName, invite.role, now),
      c.var.db.prepare(
        `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        reg.data.credentialId,
        userId,
        reg.data.publicKeyB64,
        reg.data.counter,
        JSON.stringify(reg.data.transports),
        reg.data.deviceType,
        reg.data.backedUp ? 1 : 0,
        null,
        now,
      ),
      c.var.db.prepare(`INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{}', ?)`).bind(
        userId,
        now,
      ),
    ]);
    const session = await createSession(c.env, userId, { ip: getIp(c), userAgent: getUa(c) });
    setCookies(c, session.cookies);
    await audit(c.var.db, {
      userId,
      action: 'auth.register',
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { email: invite.email, credentialId: reg.data.credentialId },
    });
    return c.json({ ok: true, totpSetupRequired: true });
  });

  /* ---------- 登入：Passkey ---------- */
  app.post('/login/options', async (c) => {
    const body = z.object({ email: z.string().email() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const email = body.data.email.toLowerCase();
    const user = await c.var.db.prepare(`SELECT * FROM users WHERE email = ? AND status = 'active'`)
      .bind(email)
      .first<UserRow>();
    const creds = user
      ? await c.var.db.prepare(`SELECT id FROM credentials WHERE user_id = ?`).bind(user.id).all<{ id: string }>()
      : null;
    // F16.4（2026-09-20 掃描 F6+F7）：原本這裡對未知帳號回**空** allowCredentials，對真帳號回真實
    // credential id —— 空 vs 非空就是一個「這個信箱有沒有帳號」的預言機，還順帶洩漏該帳號有幾把
    // passkey（credential id 是每把驗證器穩定不變的識別碼）。原本的註解宣稱這樣可防枚舉，是錯的。
    // 現在沒有可用憑證時改回一組由 HMAC 導出的穩定誘餌（auth/loginDecoy.ts，**不查 credentials 表**）。
    // 真帳號但零憑證的情況也走誘餌：那種帳號本來就登不進來，回空只會洩漏它存在。
    // 殘留（loginDecoy.ts 有完整列表）：持有 3 把以上 passkey 的真帳號，回應形狀仍可辨識。
    const realIds = creds?.results.map((r) => r.id) ?? [];
    const options = await makeAuthenticationOptions(
      c.env,
      realIds.length ? realIds : await decoyCredentialIds(c.env, email),
    );
    const challengeId = await createChallenge(
      c.env,
      'webauthn_login',
      JSON.stringify({ challenge: options.challenge, userId: user?.id ?? null }),
    );
    return c.json({ challengeId, options });
  });

  app.post('/login/verify', async (c) => {
    const body = z
      .object({ challengeId: z.string(), response: z.custom<AuthenticationResponseJSON>() })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const chal = await consumeChallenge(c.env, body.data.challengeId, 'webauthn_login');
    if (!chal) return c.json({ error: 'challenge_expired' }, 400);
    const { challenge, userId } = JSON.parse(chal.value) as { challenge: string; userId: string | null };

    const cred = await c.var.db.prepare(`SELECT * FROM credentials WHERE id = ?`)
      .bind(body.data.response.id)
      .first<CredentialRow>();
    if (!cred || (userId && cred.user_id !== userId)) return c.json({ error: 'verification_failed' }, 400);

    const result = await checkAuthentication(c.env, {
      response: body.data.response,
      expectedChallenge: challenge,
      credential: cred,
    });
    if (!result) return c.json({ error: 'verification_failed' }, 400);
    await c.var.db.prepare(`UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?`)
      .bind(result.newCounter, Date.now(), cred.id)
      .run();

    const user = await c.var.db.prepare(`SELECT * FROM users WHERE id = ? AND status = 'active'`)
      .bind(cred.user_id)
      .first<UserRow>();
    if (!user) return c.json({ error: 'verification_failed' }, 400);

    const totp = await c.var.db.prepare(`SELECT enabled FROM totp_secrets WHERE user_id = ?`)
      .bind(user.id)
      .first<{ enabled: number }>();

    if (totp?.enabled) {
      // 信任裝置：30 天內免再驗 TOTP（cookie 有效則直接發 session）
      const deviceToken = parseCookies(c.req.header('Cookie') ?? null)[cookieNames(c.env).device];
      if (await isTrustedDevice(c.env, user.id, deviceToken)) {
        const session = await createSession(c.env, user.id, { ip: getIp(c), userAgent: getUa(c) });
        setCookies(c, session.cookies);
        await audit(c.var.db, {
          userId: user.id,
          action: 'auth.login',
          ip: getIp(c),
          userAgent: getUa(c),
          meta: { factor: 'passkey+trusted_device' },
        });
        bgDetectDevice(c, user.id, getUa(c)); // F12.3(a)
        return c.json({ ok: true });
      }
      // 第二步：TOTP。發 5 分鐘有效的一次性 totpToken
      const totpToken = await createChallenge(c.env, 'totp_login', JSON.stringify({ attempts: 0 }), user.id);
      return c.json({ totpRequired: true, totpToken });
    }

    // TOTP 尚未啟用：發 session 但前端會被 mfa_setup_required 導去設定（強制入會）
    const session = await createSession(c.env, user.id, { ip: getIp(c), userAgent: getUa(c) });
    setCookies(c, session.cookies);
    await audit(c.var.db, {
      userId: user.id,
      action: 'auth.login',
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { factor: 'passkey' },
    });
    bgDetectDevice(c, user.id, getUa(c)); // F12.3(a)：入會登入也記錄裝置（首台 isNew=false 不誤報）
    return c.json({ ok: true, totpSetupRequired: true });
  });

  // F12.3(a)：背景偵測新裝置並推播（絕不阻斷登入；executionCtx 不可用時退為 floating promise）
  function bgDetectDevice(c: { env: Env; executionCtx?: ExecutionContext }, userId: string, ua: string | null) {
    const p = maybeNotifyNewDevice(c.env, userId, ua);
    try { c.executionCtx?.waitUntil(p); } catch { void p.catch(() => {}); }
  }

  /* ---------- 登入第二步：TOTP 或備援碼 ---------- */
  app.post('/totp/challenge', async (c) => {
    const body = z
      .object({ totpToken: z.string(), code: z.string().min(6).max(16), trustDevice: z.boolean().optional() })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const chal = await peekChallenge(c.env, body.data.totpToken, 'totp_login');
    if (!chal || !chal.user_id) return c.json({ error: 'challenge_expired' }, 400);

    const state = JSON.parse(chal.value) as { attempts: number };
    if (state.attempts >= TOTP_MAX_ATTEMPTS) {
      await deleteChallenge(c.env, chal.id);
      return c.json({ error: 'too_many_attempts' }, 429);
    }
    // 原子認領一次嘗試（CAS on value）：並發請求只有一個能把 attempts +1，
    // 杜絕「平行猜碼讀到同一 attempts 互相覆蓋」繞過 5 次上限。輸了 CAS 的保守拒絕。
    const claimed = await c.var.db.prepare(`UPDATE challenges SET value = ? WHERE id = ? AND value = ?`)
      .bind(JSON.stringify({ attempts: state.attempts + 1 }), chal.id, chal.value)
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) return c.json({ error: 'too_many_attempts' }, 429);

    const input = body.data.code.trim();
    let ok = false;
    let factor = 'totp';
    if (/^\d{6}$/.test(input)) {
      const secretRow = await c.var.db.prepare(`SELECT secret_enc FROM totp_secrets WHERE user_id = ? AND enabled = 1`)
        .bind(chal.user_id)
        .first<{ secret_enc: string }>();
      if (secretRow) {
        const secret = await aesGcmDecrypt(c.env.TOTP_ENC_KEY, secretRow.secret_enc);
        ok = await verifyTotp(secret, input);
      }
    } else {
      ok = await consumeBackupCode(c.env, chal.user_id, input);
      factor = 'backup_code';
    }

    if (!ok) {
      // attempts 已於上方 CAS 原子 +1，此處只回報剩餘次數
      return c.json({ error: 'invalid_code', attemptsLeft: TOTP_MAX_ATTEMPTS - state.attempts - 1 }, 400);
    }

    await deleteChallenge(c.env, chal.id);
    const session = await createSession(c.env, chal.user_id, { ip: getIp(c), userAgent: getUa(c) });
    setCookies(c, session.cookies);
    bgDetectDevice(c, chal.user_id, getUa(c)); // F12.3(a)
    // 勾選「30 天信任這台裝置」→ 下次登入過 passkey 後免再驗 TOTP
    if (body.data.trustDevice) {
      setCookies(c, [await createTrustedDevice(c.env, chal.user_id, getUa(c))]);
    }
    await audit(c.var.db, {
      userId: chal.user_id,
      action: 'auth.login',
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { factor, trustedDevice: !!body.data.trustDevice },
    });
    return c.json({ ok: true });
  });

  /* ---------- 救援：用 admin 核發的 token 對既有帳號重新綁定 passkey ----------
     解決「失去所有 passkey → 無法登入、無法重註冊（email UNIQUE）」的鎖死。
     只「新增」credential，不刪舊、不改 status、不自動發 session（仍需既有 TOTP 才能登入）。 */
  app.post('/recover/check', async (c) => {
    const body = z.object({ token: z.string().min(8) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const rec = await findValidRecoveryToken(c.env, body.data.token);
    if (!rec) return c.json({ error: 'invalid_token' }, 404);
    const user = await c.var.db.prepare(
      `SELECT u.email, (SELECT enabled FROM totp_secrets t WHERE t.user_id = u.id) AS totp
       FROM users u WHERE u.id = ? AND u.status = 'active'`,
    )
      .bind(rec.user_id)
      .first<{ email: string; totp: number | null }>();
    if (!user) return c.json({ error: 'invalid_token' }, 404);
    // 安全閘門：只對已啟用 TOTP 的帳號開放救援（見 admin /users/:id/recovery 註解）
    if (!user.totp) return c.json({ error: 'totp_not_enabled' }, 409);
    return c.json({ email: user.email });
  });

  app.post('/recover/options', async (c) => {
    const body = z.object({ token: z.string().min(8) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const rec = await findValidRecoveryToken(c.env, body.data.token);
    if (!rec) return c.json({ error: 'invalid_token' }, 404);
    const user = await c.var.db.prepare(`SELECT id, email FROM users WHERE id = ? AND status = 'active'`)
      .bind(rec.user_id)
      .first<{ id: string; email: string }>();
    if (!user) return c.json({ error: 'invalid_token' }, 404);
    const creds = await c.var.db.prepare(`SELECT id FROM credentials WHERE user_id = ?`)
      .bind(user.id)
      .all<{ id: string }>();
    const options = await makeRegistrationOptions(c.env, {
      userIdB64url: bufToB64url(new TextEncoder().encode(user.id)),
      email: user.email,
      excludeCredentialIds: creds.results.map((r) => r.id),
    });
    const challengeId = await createChallenge(
      c.env,
      'webauthn_recover',
      JSON.stringify({ challenge: options.challenge, userId: user.id, recId: rec.id }),
      user.id,
      REGISTER_CHALLENGE_TTL_MS,
    );
    return c.json({ challengeId, options });
  });

  app.post('/recover/verify', async (c) => {
    const body = z
      .object({
        token: z.string().min(8),
        challengeId: z.string(),
        response: z.custom<RegistrationResponseJSON>(),
        name: z.string().max(64).optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const rec = await findValidRecoveryToken(c.env, body.data.token);
    if (!rec) return c.json({ error: 'invalid_token' }, 404);
    const chal = await consumeChallenge(c.env, body.data.challengeId, 'webauthn_recover');
    if (!chal) return c.json({ error: 'challenge_expired' }, 400);
    const { challenge, userId, recId } = JSON.parse(chal.value) as { challenge: string; userId: string; recId: string };
    // 綁定一致性：這個 webauthn challenge 必須屬於本 token 對應的 user
    if (recId !== rec.id || userId !== rec.user_id) return c.json({ error: 'token_mismatch' }, 400);
    const user = await c.var.db.prepare(
      `SELECT u.id, u.email, (SELECT enabled FROM totp_secrets t WHERE t.user_id = u.id) AS totp
       FROM users u WHERE u.id = ? AND u.status = 'active'`,
    )
      .bind(rec.user_id)
      .first<{ id: string; email: string; totp: number | null }>();
    if (!user) return c.json({ error: 'invalid_token' }, 404);
    // 安全閘門（縱深）：未啟用 TOTP 的帳號登入會走免 TOTP 快路徑 → 不得用救援加 passkey
    // （否則光憑 token 即可接管）。正常情況 admin 端已擋下，這裡是第二道。
    if (!user.totp) return c.json({ error: 'totp_not_enabled' }, 409);

    const reg = await checkRegistration(c.env, { response: body.data.response, expectedChallenge: challenge });
    if (!reg.ok) {
      await audit(c.var.db, {
        userId: user.id,
        action: 'auth.recover.fail',
        ip: getIp(c),
        userAgent: getUa(c),
        meta: { reason: reg.reason },
      });
      return c.json({ error: 'verification_failed', reason: reg.reason }, 400);
    }
    // 單次：原子標記已用（併發重放只有一個成功），再寫入新 credential
    if (!(await markRecoveryUsed(c.env, rec.id))) return c.json({ error: 'invalid_token' }, 404);
    // recovery_bound=1：這把 passkey 只憑救援連結綁定、未經第二因子確認 → admin 重設 TOTP 前必須逐一承認
    // （見 api/admin.ts 的 /users/:id/totp/reset）。
    // WHERE EXISTS(totp enabled)：把上面那道 totp_not_enabled 閘門變成原子的。閘門是「先讀後寫」，
    // admin 剛好在這中間完成重設時，這筆 INSERT 會落在已無第二因子的帳號上（＝免 TOTP 快路徑接管）。
    // 條件式 INSERT 讓「TOTP 仍啟用」與「寫入 credential」同進退；輸掉這個競態只是燒掉一張救援 token。
    const inserted = await c.var.db.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at, recovery_bound)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
        WHERE EXISTS (SELECT 1 FROM totp_secrets WHERE user_id = ? AND enabled = 1)`,
    )
      .bind(
        reg.data.credentialId,
        user.id,
        reg.data.publicKeyB64,
        reg.data.counter,
        JSON.stringify(reg.data.transports),
        reg.data.deviceType,
        reg.data.backedUp ? 1 : 0,
        sanitizePasskeyName(body.data.name) ?? '救援重新綁定',
        Date.now(),
        user.id,
      )
      .run();
    if (!(inserted.meta.changes ?? 0)) return c.json({ error: 'totp_not_enabled' }, 409);
    await audit(c.var.db, {
      userId: user.id,
      action: 'auth.recover.complete',
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { credentialId: reg.data.credentialId },
    });
    return c.json({ ok: true, email: user.email });
  });

  /* ---------- 已登入區 ---------- */
  app.use('/me', requireSession);
  app.use('/logout', requireSession);
  app.use('/totp/setup', requireSession);
  app.use('/totp/verify', requireSession);
  app.use('/backup-codes/regenerate', requireSession);
  app.use('/passkeys', requireSession);
  app.use('/passkeys/*', requireSession);
  app.use('/passkey/add/*', requireSession);
  app.use('/sessions', requireSession);
  app.use('/sessions/*', requireSession);

  app.get('/me', async (c) => {
    const user = c.var.user;
    const [totp, settings, backupLeft, defaultSig] = await Promise.all([
      c.var.db.prepare(`SELECT enabled FROM totp_secrets WHERE user_id = ?`).bind(user.id).first<{ enabled: number }>(),
      c.var.db.prepare(`SELECT signature, prefs FROM user_settings WHERE user_id = ?`)
        .bind(user.id)
        .first<{ signature: string; prefs: string }>(),
      remainingBackupCodes(c.env, user.id),
      // F4.4：有預設簽名就用它的內容；否則沿用舊的 user_settings.signature（向後相容、不破壞既有單一簽名）。
      c.var.db.prepare(`SELECT content FROM signatures WHERE user_id = ? AND is_default = 1 LIMIT 1`).bind(user.id).first<{ content: string }>(),
    ]);
    return c.json({
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
      avatarUrl: user.avatar_key ? `/api/v1/avatars/${user.id}?v=${user.avatar_key.split('/').pop()}` : null,
      totpEnabled: !!totp?.enabled,
      isDemo: !!user.is_demo, // 唯讀 demo 帳號 → 前端顯示橫幅 + 隱藏 Compose
      backupCodesLeft: backupLeft,
      signature: defaultSig?.content ?? settings?.signature ?? '',
      prefs: JSON.parse(settings?.prefs ?? '{}') as Record<string, unknown>,
    });
  });

  app.post('/logout', async (c) => {
    await revokeSession(c.env, c.var.session.id);
    // F5：連同綁在這個 session 的 push 訂閱一起撤掉，否則這台瀏覽器登出後仍會收到每封新信的寄件者＋主旨。
    // 只刪本 session 的那列 → 其他仍登入中的裝置不受影響。
    await revokePushSubscriptionsForSession(c.env, c.var.user.id, c.var.session.id);
    setCookies(c, clearSessionCookies(c.env));
    await audit(c.var.db, { userId: c.var.user.id, action: 'auth.logout', ip: getIp(c), userAgent: getUa(c) });
    return c.json({ ok: true });
  });

  /* ---------- TOTP 設定（註冊精靈 / 設定頁） ---------- */
  app.post('/totp/setup', async (c) => {
    const user = c.var.user;
    // F2 守門：已啟用的帳號不可透過此端點重設（否則在驗證新碼前就把現有第二因子降級）。
    // 僅允許「尚未啟用」(無列或 enabled=0) 時建立/覆寫待驗證的 secret。
    const existing = await c.var.db.prepare(`SELECT enabled FROM totp_secrets WHERE user_id = ?`)
      .bind(user.id)
      .first<{ enabled: number }>();
    if (existing?.enabled) return c.json({ error: 'totp_already_enabled' }, 409);
    const secret = generateTotpSecret();
    const enc = await aesGcmEncrypt(c.env.TOTP_ENC_KEY, secret);
    await c.var.db.prepare(
      `INSERT INTO totp_secrets (user_id, secret_enc, enabled, created_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, enabled = 0, created_at = excluded.created_at`,
    )
      .bind(user.id, enc, Date.now())
      .run();
    return c.json({ secret, otpauth: otpauthUri(secret, user.email) });
  });

  app.post('/totp/verify', async (c) => {
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const user = c.var.user;
    const row = await c.var.db.prepare(`SELECT secret_enc FROM totp_secrets WHERE user_id = ?`)
      .bind(user.id)
      .first<{ secret_enc: string }>();
    if (!row) return c.json({ error: 'totp_not_setup' }, 400);
    const secret = await aesGcmDecrypt(c.env.TOTP_ENC_KEY, row.secret_enc);
    if (!(await verifyTotp(secret, body.data.code))) return c.json({ error: 'invalid_code' }, 400);
    await c.var.db.prepare(`UPDATE totp_secrets SET enabled = 1 WHERE user_id = ?`).bind(user.id).run();
    // 第二因子剛建立/變更：作廢任何既有信任裝置，逼下次重新驗證
    await revokeTrustedDevices(c.env, user.id);
    const backupCodes = await generateBackupCodes(c.env, user.id);
    await audit(c.var.db, { userId: user.id, action: 'auth.totp.enable', ip: getIp(c), userAgent: getUa(c) });
    return c.json({ ok: true, backupCodes });
  });

  /* ---------- 自助重新產生備援碼（趁還登入著補一份，覆蓋舊碼） ---------- */
  app.post('/backup-codes/regenerate', async (c) => {
    const user = c.var.user;
    const totp = await c.var.db.prepare(`SELECT enabled FROM totp_secrets WHERE user_id = ?`)
      .bind(user.id)
      .first<{ enabled: number }>();
    if (!totp?.enabled) return c.json({ error: 'totp_not_enabled' }, 409);
    const backupCodes = await generateBackupCodes(c.env, user.id);
    await audit(c.var.db, { userId: user.id, action: 'auth.backup_codes.regenerate', ip: getIp(c), userAgent: getUa(c) });
    return c.json({ ok: true, backupCodes });
  });

  /* ---------- Passkey 管理 ---------- */
  app.get('/passkeys', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, name, device_type, backed_up, created_at, last_used_at FROM credentials WHERE user_id = ?`,
    )
      .bind(c.var.user.id)
      .all();
    return c.json({ passkeys: rows.results });
  });

  app.post('/passkey/add/options', async (c) => {
    const user = c.var.user;
    const creds = await c.var.db.prepare(`SELECT id FROM credentials WHERE user_id = ?`)
      .bind(user.id)
      .all<{ id: string }>();
    const options = await makeRegistrationOptions(c.env, {
      userIdB64url: bufToB64url(new TextEncoder().encode(user.id)),
      email: user.email,
      excludeCredentialIds: creds.results.map((r) => r.id),
    });
    const challengeId = await createChallenge(c.env, 'webauthn_add', JSON.stringify({ challenge: options.challenge }), user.id, REGISTER_CHALLENGE_TTL_MS);
    return c.json({ challengeId, options });
  });

  app.post('/passkey/add/verify', async (c) => {
    const body = z
      .object({
        challengeId: z.string(),
        response: z.custom<RegistrationResponseJSON>(),
        name: z.string().max(64).optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const chal = await consumeChallenge(c.env, body.data.challengeId, 'webauthn_add');
    if (!chal || chal.user_id !== c.var.user.id) return c.json({ error: 'challenge_expired' }, 400);
    const { challenge } = JSON.parse(chal.value) as { challenge: string };
    const reg = await checkRegistration(c.env, { response: body.data.response, expectedChallenge: challenge });
    if (!reg.ok) return c.json({ error: 'verification_failed', reason: reg.reason }, 400);
    await c.var.db.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        reg.data.credentialId,
        c.var.user.id,
        reg.data.publicKeyB64,
        reg.data.counter,
        JSON.stringify(reg.data.transports),
        reg.data.deviceType,
        reg.data.backedUp ? 1 : 0,
        body.data.name ?? null,
        Date.now(),
      )
      .run();
    await audit(c.var.db, { userId: c.var.user.id, action: 'auth.passkey.add', ip: getIp(c), userAgent: getUa(c) });
    return c.json({ ok: true });
  });

  app.delete('/passkeys/:id', async (c) => {
    const user = c.var.user;
    const pkId = c.req.param('id');
    // 原子刪除：只在「刪完仍 >=1 把」時才刪，杜絕並發刪兩把不同 passkey 把帳號清空鎖死。
    const res = await c.var.db.prepare(
      `DELETE FROM credentials WHERE id = ? AND user_id = ?
         AND (SELECT COUNT(*) FROM credentials WHERE user_id = ?) > 1`,
    )
      .bind(pkId, user.id, user.id)
      .run();
    if (!(res.meta.changes ?? 0)) {
      // 沒刪到：分辨「擋下最後一把」與「本就不存在」以回對應錯誤
      const exists = await c.var.db.prepare(`SELECT 1 FROM credentials WHERE id = ? AND user_id = ?`)
        .bind(pkId, user.id)
        .first();
      return exists ? c.json({ error: 'last_passkey' }, 400) : c.json({ error: 'not_found' }, 404);
    }
    await audit(c.var.db, { userId: user.id, action: 'auth.passkey.remove', ip: getIp(c), userAgent: getUa(c) });
    return c.json({ ok: true });
  });

  /* ---------- Session 管理 ---------- */
  app.get('/sessions', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, client, user_agent, ip, created_at, expires_at FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
      .bind(c.var.user.id, Date.now())
      .all();
    return c.json({ sessions: rows.results, current: c.var.session.id });
  });

  app.post('/sessions/revoke-all', async (c) => {
    await revokeAllSessions(c.env, c.var.user.id);
    // F5：所有裝置都被取消授權 → 全部 push 訂閱一併刪除（含 0049 之前未綁 session 的舊列）。
    await revokePushSubscriptionsForUser(c.env, c.var.user.id);
    setCookies(c, clearSessionCookies(c.env));
    await audit(c.var.db, { userId: c.var.user.id, action: 'auth.sessions.revoke_all', ip: getIp(c), userAgent: getUa(c) });
    return c.json({ ok: true });
  });

  // F12.3(b)：撤銷單一（非本機）session。self-scoped（WHERE user_id）防越權；擋撤當前（用登出撤自己）。
  app.post('/sessions/:id/revoke', async (c) => {
    const id = c.req.param('id');
    if (id === c.var.session.id) return c.json({ error: 'cannot_revoke_current' }, 400);
    const res = await c.var.db.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
      .bind(Date.now(), id, c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    // F5：被撤銷的那台裝置的 push 訂閱一併刪除；其他裝置（含未綁 session 的舊列）不動。
    await revokePushSubscriptionsForSession(c.env, c.var.user.id, id);
    await audit(c.var.db, { userId: c.var.user.id, action: 'auth.session.revoke', targetType: 'session', targetId: id, ip: getIp(c), userAgent: getUa(c) });
    return c.json({ ok: true });
  });

  return app;
}
