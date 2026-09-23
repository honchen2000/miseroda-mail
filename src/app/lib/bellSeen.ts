// 通知鈴鐺的「看過」語意（2026-09-22 Hon 定案：點開就算看過）。純函式 → 可被 worker vitest 單測。
//
// 原本鈴鐺數字是「待辦數」（已到期跟進筆數＋有需回信就加 1），處理掉才會消失、點開不會消——
// 與一般人對鈴鐺的直覺不同（Hon 回報「點開之後不會消除數字」）。
// 現在：點開鈴鐺 → 當下已到期的項目都算看過、數字歸零；之後**有新的項目到期**或**需回信變多**才再亮。
// 清單內容不變：沒處理的跟進仍列在下拉與「跟進」頁裡，只是不再用數字催你。

export interface BellSeen {
  /** 看過的「到期項目」：`${id}@${dueAt}`——跟進被延後（dueAt 改變）會算成新的一筆。 */
  keys: string[];
  /** 看過時的需回信數。之後數量**超過**它才再加 1。 */
  needsReply: number;
}

export const EMPTY_BELL_SEEN: BellSeen = { keys: [], needsReply: 0 };

export interface DueItem {
  id: string;
  dueAt: number;
}

export function dueKey(f: DueItem): string {
  return `${f.id}@${f.dueAt}`;
}

/** localStorage 讀到的任意值 → 合法狀態（壞資料一律回空，不丟例外）。 */
export function normalizeBellSeen(raw: unknown): BellSeen {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_BELL_SEEN, keys: [] };
  const o = raw as Record<string, unknown>;
  const keys = Array.isArray(o.keys) ? o.keys.filter((k): k is string => typeof k === 'string') : [];
  const needsReply = typeof o.needsReply === 'number' && Number.isFinite(o.needsReply) && o.needsReply >= 0 ? o.needsReply : 0;
  return { keys, needsReply };
}

/** 鈴鐺數字＝沒看過的到期項目數，加上需回信數超過看過時的數量就再加 1。 */
export function unseenBadge(due: DueItem[], needsReply: number, seen: BellSeen): number {
  const seenKeys = new Set(seen.keys);
  const unseenDue = due.filter((f) => !seenKeys.has(dueKey(f))).length;
  return unseenDue + (needsReply > seen.needsReply ? 1 : 0);
}

/** 點開鈴鐺：只記「當下」已到期的項目（不再到期的自然被丟掉，存量有上限）。 */
export function markBellSeen(due: DueItem[], needsReply: number): BellSeen {
  return { keys: due.map(dueKey), needsReply };
}

/**
 * 需回信數變少（回完信）時把門檻跟著調低，之後再變多才會亮——否則「看過 3 → 回掉 2 → 又來 2」會永遠不亮。
 * `needsReply` 為 undefined（計數還沒載入）時**不動**：拿載入中的 0 去調低，資料一回來就會誤亮。
 * 回傳新的狀態；不需要改時回 null。
 */
export function lowerNeedsReply(seen: BellSeen, needsReply: number | undefined): BellSeen | null {
  if (needsReply === undefined || needsReply >= seen.needsReply) return null;
  return { ...seen, needsReply };
}
