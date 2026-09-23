// API client：JSON + cookie session + CSRF double-submit
import { BOOKMARK_HEADER, clearBookmark, getBookmark, setBookmark } from './bookmark';
import { noteUnauthorized } from './unauthorized';
import { markConnectionError } from './netstatus';

export { setUnauthorizedHandler } from './unauthorized';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public payload?: unknown,
  ) {
    super(code);
  }
}

/** 連線層失敗（逾時 / 斷線 / DNS 失敗）——不是伺服器回的 HTTP 錯誤。
 *  刻意「不」繼承 ApiError：App 以 `!(e instanceof ApiError)` 判定 networkDown（離線唯讀），此型別自然歸入該路徑。 */
export class NetworkError extends Error {
  constructor(
    public kind: 'timeout' | 'offline',
    message: string,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** 一般請求逾時（含 AI 已放寬到 60s，見各 AI 呼叫的 timeoutMs）。
 *  沒有逾時保護時，連線不穩會讓 fetch 掛到 OS 級 TCP 逾時（1–3 分）→ 按鈕凍結。 */
const DEFAULT_TIMEOUT_MS = 30_000;

function csrfFromCookie(): string | null {
  for (const part of document.cookie.split(/;\s*/)) {
    const eq = part.indexOf('=');
    const name = part.slice(0, eq);
    if (name === '__Host-csrf' || name === 'csrf') return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = csrfFromCookie();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  // D1 讀取複本的「讀你所寫」：帶上一個回應給的版本標記，保證這次讀得到自己剛才的變更。
  // 複本未開啟時伺服器端行為完全相同（全走主庫），這個標頭只是被忽略。
  const bookmark = getBookmark();
  if (bookmark) headers[BOOKMARK_HEADER] = bookmark;
  // 逾時保護：AbortController 在 timeoutMs 後中止，連線不穩就快速失敗（而非掛到 OS TCP 逾時的數分鐘）。
  // 涵蓋連線＋body 讀取（res.text() 也走 signal）；JSON.parse 為同步瞬時，不需計時。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  let payload: unknown = null;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    // 非 2xx 也要收（錯誤前可能已寫入）；5xx 則主動丟棄手上的 bookmark——萬一它已失效
    // （例：資料庫換過、格式過舊），自癒式清掉比讓使用者卡在重複失敗好。伺服器端另有格式守門。
    if (res.status >= 500) clearBookmark();
    else setBookmark(res.headers.get(BOOKMARK_HEADER));
    const text = await res.text(); // 同樣受 signal 保護：body 卡住也會逾時
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 回應（204 / 錯誤頁等）→ payload 維持 null */
    }
  } catch (err) {
    // AbortError＝逾時；其餘 fetch/text 拒絕＝斷線/DNS 失敗。兩者都歸為 NetworkError（非 ApiError）。
    // 先開「連線錯誤短窗」再丟——保證早於 react-query 的 onError，讓領域 toast 在窗內被抑制。
    markConnectionError();
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new NetworkError('timeout', '連線逾時，請稍後再試');
    }
    throw new NetworkError('offline', '連線中斷，請檢查網路後再試');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const code = (payload as { error?: string } | null)?.error ?? `http_${res.status}`;
    noteUnauthorized(path, res.status);
    throw new ApiError(res.status, code, payload);
  }
  return payload as T;
}

/* ---- 常用型別 ---- */
export interface Me {
  user: { id: string; email: string; displayName: string; role: 'admin' | 'user' };
  avatarUrl: string | null;
  totpEnabled: boolean;
  /** 唯讀 demo 帳號：顯示唯讀橫幅、隱藏/停用寄信；伺服器端亦硬擋所有變更（demo_readonly）。 */
  isDemo?: boolean;
  backupCodesLeft: number;
  signature: string;
  prefs: Record<string, unknown>;
}
