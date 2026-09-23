// 離線閱讀支援：把信件相關的 TanStack Query 快取持久化到 IndexedDB，
// 讓重新整理 / 離線時仍能讀到最近載入過的信件清單與內文。
//
// 隱私權衡：這與 service worker「絕不快取 /api」的初衷相反——信件會落在
// 本機 IndexedDB。緩解措施：
//   1) buster 以使用者 id 為鍵 → 換人登入會丟棄前一位使用者的快取；
//   2) 登出時 purgeOfflineCache() 主動清除（IDB + localStorage）；
//   3) maxAge 24h 自動過期。
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { get, set, del, values, keys, clear, createStore } from 'idb-keyval';
import type { Query, QueryClient } from '@tanstack/react-query';
import { clearBookmark } from '../api/bookmark';
import type { Me } from '../api/client';
import type { ComposerDraft } from '../api/send';

export const OFFLINE_MAX_AGE = 24 * 60 * 60 * 1000; // 24h

const store = createStore('miseroda-offline', 'tanstack-query');
const idbStorage = {
  getItem: (k: string) => get<string>(k, store).then((v) => v ?? null),
  setItem: (k: string, v: string) => set(k, v, store),
  removeItem: (k: string) => del(k, store),
};

export const offlinePersister = createAsyncStoragePersister({
  storage: idbStorage,
  key: 'miseroda-qc',
  throttleTime: 1000,
});

// 只持久化「讀信」需要的查詢：清單 / 對話串 / 計數（成功狀態才存）。
// 不持久化 auth/搜尋暫態等。me 另存 localStorage（離線開機需同步讀取）。
const PERSIST_KEYS = new Set(['messages', 'thread', 'counts']);
export function shouldDehydrateOfflineQuery(query: Query): boolean {
  const k = query.queryKey?.[0];
  return typeof k === 'string' && PERSIST_KEYS.has(k) && query.state.status === 'success';
}

const ME_KEY = 'miseroda_me';
export function savePersistedMe(me: Me): void {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    /* 隱私瀏覽 / 配額滿：略過，離線閱讀只是降級不可用 */
  }
}
export function loadPersistedMe(): Me | null {
  try {
    const s = localStorage.getItem(ME_KEY);
    return s ? (JSON.parse(s) as Me) : null;
  } catch {
    return null;
  }
}
/**
 * 登出 / 工作階段失效 / 換人：清除所有快取層。
 * 順序很重要——先同步 qc.clear()：
 *   1) 記憶體層被清空 → 下一位使用者同分頁登入讀不到上一位的查詢資料（module-level
 *      QueryClient 跨使用者共用，buster 只丟棄持久化層、不清記憶體）；
 *   2) clear() 觸發的 'removed' 事件會讓持久化訂閱排入一份「空的」dehydrate 快照，
 *      成為 throttle 尾端真正寫出的最後一筆 → 即使該寫入晚於 removeClient 觸發，
 *      落地的也是空 client（不會把信「復活」回 IndexedDB）。
 */
export async function purgeOfflineCache(qc: QueryClient): Promise<void> {
  qc.clear(); // 記憶體層：必須，buster 只丟棄持久化層、不會清記憶體
  clearBookmark(); // D1 讀取複本的版本標記：不跨使用者延用（陳年 bookmark 亦無續用價值）
  try {
    localStorage.removeItem(ME_KEY);
  } catch {
    /* ignore */
  }
  try {
    await offlinePersister.removeClient();
  } catch {
    /* ignore */
  }
  // F7.3：登出/401 一併清離線待送匣（避免換人登入看到/補送上一位的未送信）。
  try {
    await clear(outboxStore);
  } catch {
    /* ignore */
  }
}

/* ============ F7.3：離線送信「待送匣」（保守版：手動補送，不自動背景送、不碰送出路徑、無 migration） ============
 * 送信時若 navigator.onLine=false → 把整份 draft 入此 IndexedDB 佇列；連線後頂端橫幅提示，
 * 使用者「手動」按補送才回放 POST /messages/send。手動 = 不會在背景自動雙寄（送信無 client 冪等鍵）。 */
const outboxStore = createStore('miseroda-outbox', 'pending-sends');
export interface PendingSend {
  id: string;            // 本機 uuid
  draft: ComposerDraft;  // 完整送信 payload（結構化複製存入；含 replyClearStatus）
  scheduleAt: number | null;
  andArchive?: boolean;  // F7.3：傳送並封存——andArchive 不在 draft 內，需另存才能在補送時補做
  queuedAt: number;
}
export async function enqueuePendingSend(p: PendingSend): Promise<void> {
  await set(p.id, p, outboxStore);
}
export async function listPendingSends(): Promise<PendingSend[]> {
  const all = await values<PendingSend>(outboxStore);
  return all.sort((a, b) => a.queuedAt - b.queuedAt); // 先進先送
}
export async function removePendingSend(id: string): Promise<void> {
  await del(id, outboxStore);
}
export async function countPendingSends(): Promise<number> {
  return (await keys(outboxStore)).length;
}
