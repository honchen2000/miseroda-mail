import { createMiddleware } from 'hono/factory';
import { cookieNames, getSessionAuth, parseCookies, type SessionRow, type UserRow } from '../auth/sessions';
import { allowedOrigins } from '../auth/webauthn';

export type Vars = {
  user: UserRow;
  session: SessionRow;
  /** 本請求的 D1 一致性 session（見下方 dbSession）。⚠️ 與登入態的 `session` 無關。 */
  db: D1DatabaseSession;
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* ---- D1 讀取複本：每請求一個 D1 session ----
 *
 * ⚠️ 命名警告：這裡的 "dbSession" 是 **D1 的一致性 session**（bookmark 機制），
 *    與本專案的登入態 session（`c.var.session` / `getSessionUser`）是完全不同的東西。
 *
 * 為什麼要有它：主庫遷到 APAC 後會開全球讀取複本，而複本是最終一致的。D1 session
 * 保證「同一個 session 內的查詢有循序一致性」——session 內寫入後的讀一定看得到自己的寫。
 * 前端把回應的 X-D1-Bookmark 帶回下一個請求，就把這個保證延伸成跨請求的「讀你所寫」。
 *
 * 讀取複本**關閉**時，Sessions API 的行為與直接用 env.DB 完全相同（全部走主庫）——
 * 這是「先上程式（零行為改變）、之後再開複本」能分兩步走的依據。
 */
export const BOOKMARK_HEADER = 'X-D1-Bookmark';

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * 資料庫世代標記。**換 `wrangler.jsonc` 的 `DB` database_id 時必須一起改這個字串。**
 *
 * 為什麼需要它（2026-07-24 實測踩到，見 LESSONS L9）：bookmark 是「某個資料庫的版本座標」，
 * 拿 A 庫的 bookmark 去 `B.withSession(bookmark)` 會直接拋錯 → 每個請求 500。
 * 而前端把 bookmark 存在 localStorage，所以遷庫之後，**所有舊分頁都握著一顆會炸的字串**。
 * 實測：舊庫 bookmark（序號 000000ab…）打新庫（序號 00000001…）穩定 500，與複本開關無關。
 *
 * 對策：回應帶出去的是 `<tag>.<bookmark>`，收進來時 tag 不符就整個忽略（退回 constraint）。
 * 遷庫時 tag 一改，全世界的舊 bookmark 自動失效、靜默降級為「這次讀取可能不夠新」，
 * 而不是把使用者鎖在門外——後者是本專案的最高禁忌。
 */
const BOOKMARK_TAG = 'apac1';

// tag 後面那段直接餵給 withSession()，所以只收「長得像 D1 bookmark」的值（十六進位＋連字號、長度有界）。
// 格式若隨 D1 演進而改變，這裡會靜默退回無 bookmark 模式（讀取仍正確，只是可能不夠新），不會壞掉。
const BOOKMARK_RE = /^[0-9a-f-]{16,128}$/i;

/** 解析前端帶來的 `<tag>.<bookmark>`；tag 不符、格式不對、或根本沒有 tag（遷庫前的舊格式）→ undefined。 */
export function parseBookmark(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const dot = raw.indexOf('.');
  if (dot < 0 || raw.slice(0, dot) !== BOOKMARK_TAG) return undefined;
  const bm = raw.slice(dot + 1);
  return BOOKMARK_RE.test(bm) ? bm : undefined;
}

export const dbSession = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const incoming = parseBookmark(c.req.header(BOOKMARK_HEADER)?.trim());
  // 變更請求一律 first-primary，**刻意不採用前端帶來的 bookmark**：寫本來就只能在主庫執行，
  // 錨在 bookmark 只會讓「寫之前的那個讀」有機會落在較舊的複本（典型 read-then-write：
  // 先查歸屬再 UPDATE）。first-primary 嚴格更新、且不損失任何速度。
  const anchor = READ_METHODS.has(c.req.method) ? incoming || 'first-unconstrained' : 'first-primary';
  const d1 = c.env.DB.withSession(anchor);
  c.set('db', d1);
  await next();
  const bookmark = d1.getBookmark(); // 本請求未查任何 DB → null
  if (!bookmark) return;
  try {
    c.res.headers.set(BOOKMARK_HEADER, `${BOOKMARK_TAG}.${bookmark}`);
  } catch {
    // 少數回應的 headers 是 immutable（如 /realtime 把 DO 的 WebSocket 升級回應原樣轉出）。
    // 帶不回 bookmark 只是少一個一致性提示——絕不能因此讓請求失敗。
  }
});

/** 同源檢查：有 Origin 標頭的變更請求必須來自允許清單 */
export const originCheck = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (MUTATING.has(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && !allowedOrigins(c.env).includes(origin)) {
      return c.json({ error: 'bad_origin' }, 403);
    }
  }
  await next();
});

// MFA 強制：未啟用 TOTP 的已登入者，只能存取「完成入會」所需的端點，
// 其餘一律 403 mfa_setup_required（前端據此導去設定精靈）。
const MFA_SETUP_ALLOWLIST = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/totp/setup',
  '/api/v1/auth/totp/verify',
]);

/** 需要登入的路由 */
export const requireSession = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  // 效能迴圈 P9：同一個請求已驗證過就直接放行。
  // send／settings／ai／mail 四個 router 都掛在 '/' 並各自 `use('*', requireSession)`，Hono 合併後會對同一支請求
  // 依註冊順序**全部執行**（mail 路由 4 次、ai 3 次、settings 2 次）——舊版等於每支信箱請求串行跑 12 趟 D1 查詢。
  // `c.var.user` 只在本函式「全部檢查通過」之後才設定（下方兩處 c.set，全專案唯一），所以它存在＝這支請求
  // 已通過同一套 session／demo／CSRF／TOTP 檢查；再跑一次是同樣的輸入、同樣的判定，只多付 D1 往返。
  if (c.get('user')) {
    await next();
    return;
  }
  const names = cookieNames(c.env);
  const cookies = parseCookies(c.req.header('Cookie') ?? null);
  const token = cookies[names.session];
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  // ⚠️ auth 一律讀主庫（`c.env` → getSessionAuth 內用 env.DB），**刻意不走 c.var.db**：
  // 複本是最終一致，若 session 查詢讀到落後的複本會有兩種故障——剛登入的人被 401 擋在門外
  // （違反「絕不把使用者鎖在外面」），或剛撤銷的 session 仍可用（安全窗口）。
  // 速度紅利本來就來自內文/列表/計數那些重讀取，不是這兩個小查詢；安全優先。
  // 效能迴圈 P9：session、使用者、TOTP 旗標一趟 D1 batch 取回（原本 3 趟串行），判定順序與結果不變——見 getSessionAuth。
  const found = await getSessionAuth(c.env, token);
  if (!found) return c.json({ error: 'unauthorized' }, 401);

  // 唯讀 demo 帳號：任何變更請求（POST/PUT/PATCH/DELETE）一律 403 demo_readonly，硬性擋在 middleware。
  // 讀取放行；免 CSRF/MFA gate——demo 本就無 passkey/TOTP，且此分支已擋死所有寫入，無風險。
  // 只對 is_demo=1 觸發，一般帳號完全走下方原邏輯（passkey+TOTP 流程零改動）。
  if (found.user.is_demo) {
    // 允許登出（撤銷自己這個 demo session、清 cookie，讓參觀者能離開）；其餘變更一律擋。
    if (MUTATING.has(c.req.method) && c.req.path !== '/api/v1/auth/logout') {
      return c.json({ error: 'demo_readonly' }, 403);
    }
    c.set('user', found.user);
    c.set('session', found.session);
    await next();
    return;
  }

  // CSRF double-submit：變更請求必須帶與 csrf cookie 相同的標頭
  if (MUTATING.has(c.req.method)) {
    const header = c.req.header('X-CSRF-Token');
    if (!header || header !== cookies[names.csrf]) {
      return c.json({ error: 'csrf_mismatch' }, 403);
    }
  }

  // 伺服器端強制兩步驟驗證：TOTP 未啟用者擋在入會流程內
  if (!MFA_SETUP_ALLOWLIST.has(c.req.path)) {
    // 同上：這是「擋不擋得住／擋不擋錯人」的 gate，讀到落後複本會把剛啟用 TOTP 的人
    // 卡在設定精靈裡 → 一律走主庫。旗標已在 getSessionAuth 的同一個主庫 batch 裡讀出（env.DB，非 c.var.db）。
    if (!found.totpEnabled) return c.json({ error: 'mfa_setup_required' }, 403);
  }

  c.set('user', found.user);
  c.set('session', found.session);
  await next();
});

export const requireAdmin = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  if (c.var.user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
});

export function getIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  return c.req.header('CF-Connecting-IP') ?? null;
}

export function getUa(c: { req: { header: (n: string) => string | undefined } }): string | null {
  return c.req.header('User-Agent')?.slice(0, 255) ?? null;
}

/** 信箱必須屬於本網域 */
export function isDomainEmail(env: Env, email: string): boolean {
  return new RegExp(`^[a-z0-9._+-]+@${env.MAIL_DOMAIN.replace('.', '\\.')}$`).test(email.toLowerCase());
}
