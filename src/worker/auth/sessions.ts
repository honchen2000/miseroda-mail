import { randomToken, sha256Hex, bufToB64url, randomBytes } from '../lib/crypto';
import { newId } from '../lib/ids';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export interface SessionRow {
  id: string;
  user_id: string;
  client: string;
  user_agent: string | null;
  ip: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  created_at: number;
  last_login_at: number | null;
  avatar_key: string | null;
  /** 唯讀 demo 帳號旗標（0/1）；1 = 所有變更請求被擋（見 middleware.requireSession）。 */
  is_demo: number;
}

export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天免再驗 TOTP

/** cookie 名稱：https 用 __Host- 前綴（最嚴格），本機 http 開發用無前綴名 */
export function cookieNames(env: Env): { session: string; csrf: string; device: string; secure: boolean } {
  const secure = env.ORIGIN.startsWith('https://');
  return {
    session: secure ? '__Host-session' : 'session',
    csrf: secure ? '__Host-csrf' : 'csrf',
    device: secure ? '__Host-device' : 'device',
    secure,
  };
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
  }
  return out;
}

export async function createSession(
  env: Env,
  userId: string,
  req: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; csrf: string; cookies: string[] }> {
  const token = randomToken();
  const csrf = bufToB64url(randomBytes(32));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, client, user_agent, ip, created_at, expires_at)
     VALUES (?, ?, 'web', ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(token), userId, req.userAgent ?? null, req.ip ?? null, now, now + SESSION_TTL_MS)
    .run();
  await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(now, userId).run();
  return { token, csrf, cookies: sessionCookies(env, token, csrf) };
}

function cookie(name: string, value: string, opts: { secure: boolean; httpOnly: boolean; maxAge: number }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${opts.maxAge}`,
    'SameSite=Strict',
  ];
  if (opts.secure) parts.push('Secure');
  if (opts.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

export function sessionCookies(env: Env, token: string, csrf: string): string[] {
  const names = cookieNames(env);
  const maxAge = SESSION_TTL_MS / 1000;
  return [
    cookie(names.session, token, { secure: names.secure, httpOnly: true, maxAge }),
    // CSRF cookie 給前端 JS 讀（double-submit），不設 HttpOnly
    cookie(names.csrf, csrf, { secure: names.secure, httpOnly: false, maxAge }),
  ];
}

export function clearSessionCookies(env: Env): string[] {
  const names = cookieNames(env);
  return [
    cookie(names.session, '', { secure: names.secure, httpOnly: true, maxAge: 0 }),
    cookie(names.csrf, '', { secure: names.secure, httpOnly: false, maxAge: 0 }),
  ];
}

/* ---- 信任裝置（通過 TOTP 後 30 天內免再驗，token hash 存 D1） ---- */

/** 建立信任裝置紀錄並回傳要 Set-Cookie 的 device cookie */
export async function createTrustedDevice(
  env: Env,
  userId: string,
  userAgent: string | null,
): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO trusted_devices (id, user_id, token_hash, user_agent, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('tdev'), userId, await sha256Hex(token), userAgent, now, now + TRUSTED_DEVICE_TTL_MS, now)
    .run();
  const names = cookieNames(env);
  return cookie(names.device, token, {
    secure: names.secure,
    httpOnly: true,
    maxAge: TRUSTED_DEVICE_TTL_MS / 1000,
  });
}

/** 驗證 device cookie 是否為該使用者的有效信任裝置（過期/撤銷/不符皆 false） */
export async function isTrustedDevice(env: Env, userId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at FROM trusted_devices WHERE token_hash = ?`,
  )
    .bind(hash)
    .first<{ user_id: string; expires_at: number }>();
  if (!row || row.user_id !== userId || row.expires_at < Date.now()) return false;
  await env.DB.prepare(`UPDATE trusted_devices SET last_used_at = ? WHERE token_hash = ?`)
    .bind(Date.now(), hash)
    .run();
  return true;
}

/** 撤銷使用者所有信任裝置（停用 / 刪除 / 重設 TOTP 時呼叫） */
export async function revokeTrustedDevices(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM trusted_devices WHERE user_id = ?`).bind(userId).run();
}

/**
 * 驗 session 並一次取回 session、使用者與 TOTP 啟用旗標——**一趟 D1 往返**（效能迴圈 P9，2026-09-22）。
 *
 * 原本每個登入後的請求要對主庫串行跑 3 趟：sessions → users（依 session.user_id）→ totp_secrets（依 user.id，
 * 在 middleware 裡），後兩支都依賴前一支的結果。這裡改用 `db.batch` 一次送出，後兩支以
 * `(SELECT user_id FROM sessions WHERE id = ?)` 子查詢取代對前一支結果的依賴；batch 是單一交易，三支看到同一份快照。
 * 沿用本專案既有的 batch 模式（/mailbox/counts、/messages/:id），並保留 `SELECT *`（不手列欄位，日後加欄位不會漂移）。
 *
 * **判定規則與舊版逐條相同**（任一不成立回 null）：session 存在、未撤銷、未過期；使用者存在且 status = 'active'。
 * 差別只在：session 無效時，users／totp 兩支也已經讀了——結果直接丟掉，不回傳、不寫入，沒有副作用。
 * 一律讀主庫（env.DB），理由見 middleware.requireSession 的註解（複本落後會把剛登入的人擋在外面）。
 */
export async function getSessionAuth(
  env: Env,
  token: string,
): Promise<{ session: SessionRow; user: UserRow; totpEnabled: boolean } | null> {
  const id = await sha256Hex(token);
  const [sessionRes, userRes, totpRes] = await env.DB.batch<unknown>([
    env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id),
    env.DB.prepare(`SELECT * FROM users WHERE id = (SELECT user_id FROM sessions WHERE id = ?)`).bind(id),
    env.DB.prepare(`SELECT enabled FROM totp_secrets WHERE user_id = (SELECT user_id FROM sessions WHERE id = ?)`).bind(id),
  ]);
  const session = (sessionRes.results[0] as SessionRow | undefined) ?? null;
  if (!session) return null;
  if (session.revoked_at || session.expires_at < Date.now()) return null;
  const user = (userRes.results[0] as UserRow | undefined) ?? null;
  if (!user || user.status !== 'active') return null;
  const totp = totpRes.results[0] as { enabled: number } | undefined;
  return { session, user, totpEnabled: !!totp?.enabled };
}

/** 只要 session 與使用者的呼叫端（share-target）。委派給 getSessionAuth，驗證規則只有一份。 */
export async function getSessionUser(
  env: Env,
  token: string,
): Promise<{ session: SessionRow; user: UserRow } | null> {
  const found = await getSessionAuth(env, token);
  return found ? { session: found.session, user: found.user } : null;
}

export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(Date.now(), sessionId).run();
}

export async function revokeAllSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(Date.now(), userId)
    .run();
}

/* ---- F5：Web Push 訂閱與 session 同壽 ----
 * 推播內容含寄件者與主旨，授權必須隨 session 一起結束，否則被登出／撤銷的瀏覽器會持續收到新信摘要。
 * 訂閱在 /push/subscribe 綁定當下的 session（push_subscriptions.session_id，migration 0049）。 */

/** 撤銷單一 session 時：只刪「綁在這個 session 上」的訂閱＝只影響被登出的那台裝置。
 *  刻意不碰 session_id IS NULL 的舊列——那些可能屬於其他仍登入中的裝置，誤刪會讓它們無聲失去新信通知。
 *  被登出的這台自己那列舊訂閱，由前端在登出前呼叫 /push/unsubscribe（帶本機 endpoint）移除。 */
export async function revokePushSubscriptionsForSession(env: Env, userId: string, sessionId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND session_id = ?`)
    .bind(userId, sessionId)
    .run();
}

/** 撤銷全部 session／停用帳號時：所有裝置都被取消授權 → 連同未綁定的舊列一起刪。 */
export async function revokePushSubscriptionsForUser(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).bind(userId).run();
}

/* ---- 一次性 challenge（WebAuthn / TOTP 登入第二步），存 D1 確保強一致 ---- */

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// 註冊 ceremony 在不熟悉的裝置上（Windows Hello、Google 密碼管理工具多重對話框）
// 可能耗時數分鐘，給更寬鬆的期限避免 challenge_expired
export const REGISTER_CHALLENGE_TTL_MS = 15 * 60 * 1000;

export async function createChallenge(
  env: Env,
  type: string,
  value: string,
  userId?: string | null,
  ttlMs: number = CHALLENGE_TTL_MS,
): Promise<string> {
  const id = newId('chal');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO challenges (id, user_id, type, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId ?? null, type, value, now, now + ttlMs)
    .run();
  return id;
}

export interface ChallengeRow {
  id: string;
  user_id: string | null;
  type: string;
  value: string;
  created_at: number;
  expires_at: number;
}

/** 取出並刪除（單次使用）。型別不符或過期回 null。 */
export async function consumeChallenge(env: Env, id: string, type: string): Promise<ChallengeRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM challenges WHERE id = ?`).bind(id).first<ChallengeRow>();
  if (!row) return null;
  await env.DB.prepare(`DELETE FROM challenges WHERE id = ?`).bind(id).run();
  if (row.type !== type || row.expires_at < Date.now()) return null;
  return row;
}

/** 不刪除的讀取（TOTP 多次嘗試在上層用計數控制） */
export async function peekChallenge(env: Env, id: string, type: string): Promise<ChallengeRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM challenges WHERE id = ?`).bind(id).first<ChallengeRow>();
  if (!row || row.type !== type || row.expires_at < Date.now()) return null;
  return row;
}

export async function deleteChallenge(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM challenges WHERE id = ?`).bind(id).run();
}
