// R2 物件的「進站 colo」邊緣快取。
// 背景（2026-09-10 實測）：本 zone 的進站 colo 是浮動的（同一條線路量到過 PDX/ATL/SYD），
// 且 Smart Placement 選擇就地執行（Cf-Placement: local-SYD）→ Worker 跑在進站 colo。
// D1 有讀取複本可跟著服務（X-D1-Region: OC/replica），但 R2 沒有讀取複本這種東西
// （location hint 只決定建立時放哪、且是 best effort）→ 把桶固定在任一區域都只是賭。
// 對浮動落點免疫的做法只有一個：把「不可變」的物件快取在當下服務使用者的那個 colo。
//
// ★ 安全鐵則（順序顛倒 = 跨使用者洩漏）：呼叫端必須「先驗授權，再查快取」。
//   四個呼叫端一律先用既有 D1 查詢確認該物件屬於 c.var.user.id（查不到 → 404，
//   行為與加快取前完全相同），通過之後才呼叫本檔的 match/put。
//   另外，本檔的 key 一律是內部合成 URL（EDGE_CACHE_ORIGIN 不屬於本 zone、
//   任何真實請求都不可能長這樣），所以快取項目沒有「被 CDN 直接回給客戶端」的路徑，
//   只能由 Worker 在上述授權檢查通過後自己取用；合成 URL 內含的 R2 key 帶 user_id
//   與 message_id/上傳時戳，本身也不可猜。
//
// ★ fail-open：Cache API 在本機/測試環境（workerd、miniflare）可能是 no-op 或直接丟例外——
//   本檔所有函式都吞掉自身錯誤並退回「直接讀 R2」，絕不可因為快取壞掉就讓使用者讀不到信。

/** 總開關：線上若出問題，改成 false 再 push 即全站停用（四處呼叫端不必動）。 */
export const EDGE_CACHE_ENABLED = true;

/**
 * 快取 key 的合成 origin。刻意用不屬於本 zone 的主機名：
 * 外部請求永遠不可能命中這些 key。（若日後平台拒收跨 zone 主機名，改成同源路徑即可，僅此一行。）
 */
const EDGE_CACHE_ORIGIN = 'https://r2-cache.internal';

/**
 * 信件 HTML 快取的全域撤回槓桿。
 * 對抗式審查發現：`POST /api/v1/admin/messages/resanitize`（src/worker/api/admin.ts）
 * 會用「相同 r2_html_key」覆寫既有 R2 物件——這代表 html 快取「一旦寫入永不更動」的前提並不成立，
 * 而 Cache API 是 per-colo，`cache.delete()` 只清得到當下服務那個 colo，沒有真正的全球 purge 手段。
 * 因此唯一可行的全域撤回：改這個數字並重新部署 → edgeCacheKey('html', …) 產生的 key 全部改變，
 * 所有 colo 的舊 html 快取項目即刻變成「查無此 key」，等同全球失效（不必等 TTL、也不必逐 colo 清）。
 */
export const HTML_CACHE_VER = 1;

/**
 * TTL（秒）。
 * att：附件位元組。R2 key 每次上傳都是新的（見 lib/keys.ts r2AttKey），沒有「同 key 覆寫」路徑
 *   （對抗式審查已確認），技術上可以當 immutable 放滿 30 天。**但 Hon 於 2026-09-10 裁定改為 24 小時**：
 *   理由不是正確性而是隱私——快取沒有 purge 手段（合成 host 不在 zone 內，見 docs/ops.md），
 *   所以使用者刪掉一封信之後，附件位元組雖然應用層已讀不到（DB 列沒了 → 端點 404），
 *   實體上仍會留在服務過的各 colo 直到 TTL 到期。24 小時把這個殘留窗口從一個月縮到一天，
 *   而「同一份附件近期重複開啟」這個真正產生效益的情境幾乎不受影響。
 * html：信件 sanitized HTML。原本也比照 att 給 30 天，但 resanitize 端點會用同一個 key 覆寫 R2
 *   內容且只更新 D1、不清快取，所以 html 並非真正 immutable。24 小時是「就算忘了調高
 *   HTML_CACHE_VER 這個全域撤回槓桿，最壞情況陳舊內容也在一天內自己過期」的安全邊界——
 *   遠比 att 短，因為 html 有 att 沒有的覆寫路徑。
 * avatar：可被使用者主動換掉，5 分鐘只是同毫秒撞 key 時的保險（key 本身已含上傳時戳、即是版本）。
 */
export const EDGE_CACHE_TTL = {
  att: 24 * 3600,
  html: 24 * 3600,
  avatar: 300,
} as const;

type CtxLike = { executionCtx?: ExecutionContext };

/** 背景執行寫入，不拖慢回應；executionCtx 不可用時退為 floating promise（比照 api/auth.ts 的 bgDetectDevice）。 */
function background(c: CtxLike, p: Promise<unknown>): void {
  const swallowed = p.catch(() => {});
  try {
    c.executionCtx?.waitUntil(swallowed);
  } catch {
    void swallowed;
  }
}

/**
 * 合成快取 key：ns 區隔用途，R2 key 原樣編碼（key 本身含 user_id，不可猜）。
 * html 命名空間額外併入 HTML_CACHE_VER（例如 `html/v1/<encoded r2 key>`）——
 * att／avatar 審查已確認沒有覆寫路徑，不需要、也刻意不加這個版本段。
 */
export function edgeCacheKey(ns: 'html' | 'att' | 'avatar', r2Key: string): Request {
  const nsSegment = ns === 'html' ? `html/v${HTML_CACHE_VER}` : ns;
  return new Request(`${EDGE_CACHE_ORIGIN}/${nsSegment}/${encodeURIComponent(r2Key)}`);
}

/**
 * best-effort 清除單一 key（fail-open，吞掉自身錯誤）。
 * ★ 誠實限制：Cache API 是 per-colo，這裡只清得到「當下處理這個請求的那個 colo」——
 *   使用者散落在其他 colo 的快取項目完全不受影響，這不是全球 purge。
 *   目前唯一的全球撤回手段是上面的 HTML_CACHE_VER：改數字重新部署，讓 key 整體失效。
 *   呼叫端（resanitize 端點）拿它當「順手清一下、聊勝於無」，不能拿它當作已解決陳舊快取問題。
 */
export async function edgeCacheDelete(key: Request): Promise<void> {
  if (!EDGE_CACHE_ENABLED) return;
  try {
    await caches.default.delete(key);
  } catch {
    // 靜默：清除失敗不可反噬主流程（fail-open，比照本檔其餘函式）
  }
}

/** 查快取；未命中/停用/任何例外一律回 null（呼叫端照原路讀 R2）。 */
export async function edgeCacheMatch(key: Request): Promise<Response | null> {
  if (!EDGE_CACHE_ENABLED) return null;
  try {
    return (await caches.default.match(key)) ?? null;
  } catch {
    return null;
  }
}

/**
 * 寫入快取（背景、fail-open）。
 * 存進去的是「只有位元組 + Cache-Control（+ 選用的原始 Content-Type）」的精簡回應：
 * 客戶端看到的標頭集合永遠由呼叫端自己組，命中與否都一模一樣
 * （也因此不可能帶到 Set-Cookie 而被 Cache API 拒收）。
 * storedContentType：只有「型別存在 R2 metadata、不在 D1」的呼叫端（頭像）才需要一起存。
 */
export function edgeCachePut(
  c: CtxLike,
  key: Request,
  res: Response,
  ttlSeconds: number,
  storedContentType?: string,
): void {
  if (!EDGE_CACHE_ENABLED) return;
  try {
    const copy = res.clone(); // tee：原回應照樣串流給使用者，不必先落地成 buffer
    const stored = new Response(copy.body, {
      headers: {
        'Cache-Control': `public, max-age=${ttlSeconds}`,
        ...(storedContentType ? { 'Content-Type': storedContentType } : {}),
      },
    });
    background(c, caches.default.put(key, stored));
  } catch {
    // 靜默：快取寫入失敗絕不可反噬主流程
  }
}

/**
 * 文字物件（信件 HTML）用：命中就回快取內容，否則 load() 讀 R2 並背景寫入。
 * 空字串（R2 缺件／暫時性失敗）不入快取，避免把「查無內容」固化到 TTL 到期。
 */
export async function edgeCachedText(
  c: CtxLike,
  key: Request,
  ttlSeconds: number,
  load: () => Promise<string>,
): Promise<string> {
  const hit = await edgeCacheMatch(key);
  if (hit) {
    try {
      return await hit.text();
    } catch {
      // 快取內容讀壞 → 照原路讀 R2
    }
  }
  const text = await load();
  if (text) edgeCachePut(c, key, new Response(text), ttlSeconds);
  return text;
}
