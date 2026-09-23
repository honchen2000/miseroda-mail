// 訊息列表樂觀更新（純函式，刻意與 react-query/DOM 解耦 → 可在 worker 環境單測，
// 防止「快取結構改動但這段沒跟上」的回歸重演）。
//
// 列表快取是 useInfiniteQuery 的 { pages: [{items, nextCursor}], pageParams } 結構。
// ④a 把 useMessages 從 useQuery 改成 useInfiniteQuery 後，舊版 onMutate 仍讀 data.items
// （此結構下為 undefined）→ onMutate throw → mutationFn 不執行 → PATCH 整個沒送出，
// 導致星標/已讀/封存/刪除/貪睡/移動全部失效。本函式改走 pages 結構修正之。
export interface PatchableItem {
  id: string;
  unread: boolean;
  starred: boolean;
}
export interface MsgPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface InfinitePages<T> {
  pages: MsgPage<T>[];
  pageParams: unknown[];
}
export interface OptimisticPatch {
  unread?: boolean;
  starred?: boolean;
  folder?: string;
  snoozedUntil?: number | null;
  category?: string;
  status?: 'needs_reply' | 'waiting' | null;
  pinned?: boolean;
}

/**
 * 對 infinite-query 列表快取套用樂觀補丁。
 * unread/starred → 原地更新該信；folder/snooze/category → 把該信移出目前視圖（會在重抓後出現在新位置）。
 * data 為 undefined 或非 pages 結構時原樣回傳（守門，永不 throw）。
 */
export function patchMessagePages<T extends PatchableItem>(
  data: InfinitePages<T> | undefined,
  id: string,
  patch: OptimisticPatch,
): InfinitePages<T> | undefined {
  if (!data?.pages) return data;
  const removesFromView =
    patch.folder !== undefined || patch.snoozedUntil !== undefined || patch.category !== undefined;
  return {
    ...data,
    pages: data.pages.map((page) => {
      let items = page.items.map((m) =>
        m.id === id
          ? {
              ...m,
              unread: patch.unread ?? m.unread,
              starred: patch.starred ?? m.starred,
              // status/pinned 原地更新（不移出視圖，由 refetch 對帳工作流分頁），與 starred 行為一致。
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
            }
          : m,
      );
      if (removesFromView) items = items.filter((m) => m.id !== id);
      return { ...page, items };
    }),
  };
}

// ---------- counts 樂觀更新（usePatchMessage 標已讀/取消已讀即時反映側欄數字與分頁 badge） ----------
// 背景：/mailbox/counts 是 9 支查詢、邊緣在 PDX（單趟 ~165ms 起跳）→ onSettled 重抓要 1–2 秒才回來，
// 標已讀時側欄數字會有明顯延遲。這裡在 onMutate 當下就把差額算進 counts 快取，onSettled 的 invalidate
// 仍保留作為最終真相校正。

/** 從 useMessages 的 infinite-query 快取（queryKey = ['messages', 該次查詢的 URLSearchParams 字串]）
 * 找出某封信目前所在的 folder/category，供 counts 樂觀更新定位用。純函式，只依賴 URLSearchParams（無 DOM）。
 */
export function findMessageLocation(
  entries: readonly (readonly [readonly unknown[], { pages?: { items: { id: string }[] }[] } | undefined])[],
  id: string,
): { folder: string | null; category: string | null } {
  for (const [key, data] of entries) {
    const paramsStr = key[1];
    if (typeof paramsStr !== 'string') continue;
    const found = data?.pages?.some((p) => p.items.some((it) => it.id === id));
    if (!found) continue;
    const params = new URLSearchParams(paramsStr);
    const folder = params.get('folder');
    if (folder) return { folder, category: params.get('category') };
  }
  return { folder: null, category: null };
}

export interface CountsLike {
  folders: Record<string, { total: number; unread: number }>;
  inboxCategories: Record<string, { total: number; unread: number }>;
}

/** 對 counts 快取套用未讀數增減（下限 0）。folder/category 找不到對應鍵時安全略過（守門，永不 throw）。 */
export function patchCountsUnread<T extends CountsLike>(
  counts: T | undefined,
  loc: { folder: string | null; category: string | null },
  delta: 1 | -1,
): T | undefined {
  if (!counts) return counts;
  let changed = false;
  const folders = { ...counts.folders };
  if (loc.folder && folders[loc.folder]) {
    const cur = folders[loc.folder];
    const unread = Math.max(0, cur.unread + delta);
    if (unread !== cur.unread) {
      folders[loc.folder] = { ...cur, unread };
      changed = true;
    }
  }
  const inboxCategories = { ...counts.inboxCategories };
  if (loc.category && inboxCategories[loc.category]) {
    const cur = inboxCategories[loc.category];
    const unread = Math.max(0, cur.unread + delta);
    if (unread !== cur.unread) {
      inboxCategories[loc.category] = { ...cur, unread };
      changed = true;
    }
  }
  return changed ? { ...counts, folders, inboxCategories } : counts;
}
