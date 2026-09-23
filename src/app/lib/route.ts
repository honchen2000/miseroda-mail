// 網址 ↔ 視圖的對應（純邏輯，無 DOM、無 React）。
// 抽成獨立模組的理由：worker tsconfig 沒有 DOM lib，測試不能 import App.tsx；
// 拆檔法沿用既有先例（platform.dom.ts / composerWins.ts / avatarSources.ts）。
//
// 批次二十 F20.2。網址設計見 docs/product-roadmap.md 批次二十：
//   /                  收件匣（預設）
//   /f/<folder>        資料夾
//   /l/<labelId>       標籤
//   /calendar /contacts /files /followups /agenda /settings /admin
// 信件深連結（F20.3）：/m/<id> 掛在視圖路徑**後面** —— /f/archive/m/<id>。
// 刻意不是獨立的 /m/<id>：那樣重整時只知道要開哪封信，不知道清單該顯示哪個資料夾。

/**
 * 視圖型別。**刻意重寫一份，而不是 import api/mail 的 View**——
 * 那會連帶把 api/client.ts 拉進型別圖，而它用到 document，worker tsconfig 沒有 DOM lib
 * → 這個模組就再也不能被 worker 測試 import（CLAUDE.md「測試雷區」已載此坑）。
 *
 * 兩者漂移不會沉默：App.tsx 同時用到兩邊——`viewToPath(view)` 傳的是 View、
 * `pathToView()` 的結果餵給 `setViewRaw(v: View)` ——任一方向多出或少掉成員都會在編譯期報錯。
 */
export type View =
  | { type: 'folder'; folder: string }
  | { type: 'label'; id: string }
  | { type: 'contacts' }
  | { type: 'files' }
  | { type: 'calendar' }
  | { type: 'followups' }
  | { type: 'agenda' }
  | { type: 'settings' }
  | { type: 'admin' };

/**
 * 保留前綴：這些路徑由 worker 直接接手（wrangler.jsonc 的 run_worker_first 白名單），
 * 前端路由**絕不可**產生或接管它們，否則會把後端端點蓋掉。
 * 這份清單需與 wrangler.jsonc 的 run_worker_first 保持一致。
 */
const RESERVED_PREFIXES = ['/api', '/dl', '/share-target', '/cal', '/e'];

export function isReservedPath(pathname: string): boolean {
  if (pathname === '/e-decrypt.js') return true;
  return RESERVED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * 沒有參數的視圖。刻意與 View 型別的 type 字面量同名，省掉一張對照表。
 * 注意：'folder' 與 'label' 不在此列，它們帶參數、走 /f/ 與 /l/。
 */
const SIMPLE_VIEWS = ['contacts', 'files', 'calendar', 'followups', 'agenda', 'settings', 'admin'] as const;

/**
 * 合法的資料夾 id。**需與 src/app/components/mail.tsx 的 FOLDERS 保持一致**——
 * 那份清單在 .tsx 裡（帶 React 相依），這個無 DOM 模組 import 不了，只能鏡像一份。
 * 不一致的後果是良性的：未列入的資料夾路徑會被視為非法而回落到收件匣，不會壞掉。
 */
const FOLDER_IDS = [
  'inbox', 'starred', 'snoozed', 'needs_reply', 'waiting', 'pinned',
  'newsletter', 'receipt', 'screening', 'sent', 'drafts', 'archive', 'spam', 'trash',
] as const;

/** decodeURIComponent 對畸形輸入（單獨的 %）會丟例外——網址是使用者可控的，不能讓它炸掉整個 app。 */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** 一條完整路由＝視圖 ＋（可選的）開啟中的信。 */
export interface Route {
  view: View;
  messageId: string | null;
}

/** 信件 id 的形狀（DB 產生的是 msg_<hex>）。網址可控，不合法就不認。 */
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function viewToPath(view: View): string {
  switch (view.type) {
    case 'folder':
      // 收件匣是預設視圖 → 用根路徑，網址才不會平白多一段 /f/inbox
      return view.folder === 'inbox' ? '/' : `/f/${encodeURIComponent(view.folder)}`;
    case 'label':
      return `/l/${encodeURIComponent(view.id)}`;
    default:
      return `/${view.type}`;
  }
}

/** 視圖路徑 ＋ 信件段。沒開信時就是 viewToPath 的結果。 */
export function routeToPath(route: Route): string {
  const base = viewToPath(route.view);
  if (!route.messageId) return base;
  const prefix = base === '/' ? '' : base; // 收件匣是根路徑 → /m/<id>，其餘 → /f/archive/m/<id>
  return `${prefix}/m/${encodeURIComponent(route.messageId)}`;
}

/** 無法對應 → null（呼叫端應回落到收件匣並用 replaceState 收斂網址）。 */
export function pathToRoute(pathname: string): Route | null {
  if (isReservedPath(pathname)) return null;
  const path = pathname.replace(/\/+$/, '') || '/';
  const m = /^(.*)\/m\/([^/]+)$/.exec(path);
  if (!m) {
    const view = pathToView(path);
    return view ? { view, messageId: null } : null;
  }
  const view = pathToView(m[1] || '/'); // 前綴為空 ＝ 收件匣（/m/<id>）
  if (!view) return null;
  const id = safeDecode(m[2]);
  if (id === null || !MESSAGE_ID_RE.test(id)) return null;
  return { view, messageId: id };
}

/**
 * 在既有的 query string 上設定／移除單一參數，回傳新的 search（含前導 `?`，空則為空字串）。
 *
 * F20.4 用它同步 `?q=`。**刻意只動這一個 key、保留其餘參數**：
 * `?share=<token>`（Web Share Target 的 302）與 `?launch=`（PWA 捷徑）都是在掛載後的 effect 裡
 * 才從 `location.search` 讀出來的——如果搜尋同步直接把整串 query 重寫掉，會比它們早一步清掉，
 * 分享進來的內容就憑空消失。
 */
export function withQueryParam(search: string, key: string, value: string): string {
  const p = new URLSearchParams(search);
  if (value) p.set(key, value);
  else p.delete(key);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/**
 * 這次同步該對瀏覽器歷史做什麼。抽成純函式的理由：這是 F20.3 最容易寫錯的一段，
 * 而它完全不需要 DOM —— 只看「目前網址」與「要去的路由」。
 *
 * - 'none'：網址已經對了（popstate 帶我們來的情況就是這條，防迴圈全靠它）。
 * - 'replace'：同一視圖內從一封信換到另一封 → 歷史裡永遠只留一筆「開著信」，
 *   否則「返回鍵＝關窗格」會打折：讀完五封要按五次返回才關得掉。
 * - 'push'：其餘（換視圖、開第一封信、關掉信）。
 */
export function historyMode(currentPath: string, next: Route): 'none' | 'push' | 'replace' {
  const path = routeToPath(next);
  if (currentPath === path) return 'none';
  const current = pathToRoute(currentPath);
  const sameView = !!current && viewToPath(current.view) === viewToPath(next.view);
  if (next.messageId && current?.messageId && sameView) return 'replace';
  return 'push';
}

/** 無法對應到任何視圖 → null（呼叫端應回落到收件匣並用 replaceState 收斂網址）。 */
export function pathToView(pathname: string): View | null {
  if (isReservedPath(pathname)) return null;
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { type: 'folder', folder: 'inbox' };

  const seg = path.slice(1).split('/');
  if (seg.length === 1 && (SIMPLE_VIEWS as readonly string[]).includes(seg[0])) {
    return { type: seg[0] } as View;
  }
  if (seg.length === 2 && seg[1]) {
    const value = safeDecode(seg[1]);
    if (value === null) return null;
    if (seg[0] === 'f') {
      return (FOLDER_IDS as readonly string[]).includes(value) ? { type: 'folder', folder: value } : null;
    }
    if (seg[0] === 'l') return { type: 'label', id: value };
  }
  return null;
}
