// F3.4：薄觸覺回饋封裝。只在支援 navigator.vibrate 的裝置（Android Chrome 等）生效；
// iOS Safari 不支援 → 靜默 no-op（自動降級）。使用者把 data-motion 關掉時一併關閉觸覺。
function hapticsEnabled(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-motion') === 'off') return false;
  return true;
}

function buzz(pattern: number | number[]): void {
  if (!hapticsEnabled()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* 某些裝置/情境（如使用者手勢外）會丟例外 → 忽略 */
  }
}

export const haptics = {
  /** 輕點：星標、swipe 過閾值、勾選 */
  tap: () => buzz(8),
  /** 成功：TOTP 填滿驗證、passkey 綁定/登入成功 */
  success: () => buzz([10, 40, 16]),
  /** 警示/失敗：撰寫守門 shake */
  warn: () => buzz([22, 28, 22, 28, 22]),
  /** 較重的確認：Undo、重要動作 */
  impact: () => buzz(16),
};
