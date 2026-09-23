// F8.8：快捷鍵漸進教學。滑鼠點高頻動作（封存/刪除/回覆）時提示對應快捷鍵，
// 每個動作最多提示 3 次（localStorage 計數），學會後不再騷擾。與 data-motion 無關。
const KEY = 'miseroda_coach_v1';
const MAX_HINTS = 3;

const HINTS: Record<CoachAction, string> = {
  archive: '學個快捷鍵：下次可直接按 E 封存 ⌨️',
  delete: '學個快捷鍵：下次可直接按 # 刪除 ⌨️',
  reply: '學個快捷鍵：下次可直接按 R 回覆 ⌨️',
};

export type CoachAction = 'archive' | 'delete' | 'reply';

function read(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * 回傳這次要顯示的教學文案；若該動作已提示滿 3 次則回 null。
 * 呼叫時即累加計數（只有在真的回傳文案時才 +1，達上限後不再寫入）。
 */
export function coachHint(action: CoachAction): string | null {
  const hint = HINTS[action];
  if (!hint) return null;
  const counts = read();
  const seen = counts[action] ?? 0;
  if (seen >= MAX_HINTS) return null;
  counts[action] = seen + 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(counts));
  } catch {
    /* localStorage 不可用 → 本次仍提示，只是不累計 */
  }
  return hint;
}
