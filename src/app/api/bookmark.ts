// D1 讀取複本的「讀你所寫」憑證。
//
// 主庫遷 APAC 後會開全球讀取複本，複本是最終一致的。伺服器每個回應帶回一個 bookmark
// （資料庫版本標記），前端在下一個請求把它帶回去 → D1 保證那次讀取落在「至少和這個
// bookmark 一樣新」的複本上，使用者因此一定看得到自己剛才的變更（寄出的信、標的已讀）。
//
// ⚠️ 與登入態 session 無關。bookmark 只是版本標記：不含個資、不具授權效力，
//    而且拿到別人的 bookmark 只會讓自己的讀取「更新、更慢」，不會讀到別人的資料。
//    仍在登出/換人時清除（purgeOfflineCache）——陳年 bookmark 沒有續用價值。
//
// 已知邊界（複本開啟後要盯的點）：採「最後回應覆蓋」策略（與 Cloudflare 官方範例同）。
// 若一個變更請求完成的同時，有個更早發出的 GET 才回來，會把較舊的 bookmark 蓋上去，
// 那一瞬間的 refetch 就可能讀到舊複本。前端的 mutation→invalidate→refetch 是循序的，
// 正常路徑不受影響；此殘留風險列在計劃 §6.4 的觀察清單，有實際症狀再處理。

/** 與 worker 的 `middleware.ts` BOOKMARK_HEADER 必須一致。 */
export const BOOKMARK_HEADER = 'X-D1-Bookmark';

const KEY = 'miseroda_d1_bookmark';

let current: string | null = null;
let loaded = false;

/** 目前的 bookmark（無則 null）。首次呼叫才碰 localStorage。 */
export function getBookmark(): string | null {
  if (!loaded) {
    loaded = true;
    try {
      current = localStorage.getItem(KEY);
    } catch {
      /* 隱私瀏覽 / 配額：退回只用 module 變數，功能不受影響（重新整理後從頭開始） */
    }
  }
  return current;
}

export function setBookmark(next: string | null): void {
  if (!next || next === current) return;
  loaded = true;
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
}

/** 登出 / 工作階段失效 / 換人時呼叫（見 purgeOfflineCache）。 */
export function clearBookmark(): void {
  loaded = true;
  current = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
