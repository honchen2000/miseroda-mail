// 全域連線錯誤通知橋接（與 fetch 包裝拆開，DOM-free 便於 worker 測試）。
// 任一查詢/操作因逾時或斷線失敗時，統一以一則 toast 告知使用者「操作可能沒完成，請重試」，
// 而不是各處顯示誤導的領域訊息（如「別名重複」）。去抖：同一波多個失敗只彈一次。
let handler: ((message: string) => void) | null = null;
let lastFiredAt = 0;
let connErrAt = 0;

export function setConnectionErrorHandler(fn: ((message: string) => void) | null): void {
  handler = fn;
}

/** api() 在丟 NetworkError 前呼叫，開啟「連線錯誤短窗」。此呼叫保證早於 react-query 的 onError 鏈。 */
export function markConnectionError(now = Date.now()): void {
  connErrAt = now;
}

/** 是否在連線錯誤短窗（300ms）內 → 領域 toast 抑制，統一交給全域那一則連線 toast（避免雙 toast）。 */
export function inConnectionErrorWindow(now = Date.now()): boolean {
  return now - connErrAt < 300;
}

/** 回報連線錯誤；4 秒內只彈一次（避免多查詢同時失敗洗版）。 */
export function reportConnectionError(message: string, now = Date.now()): void {
  if (!handler) return;
  if (now - lastFiredAt < 4000) return;
  lastFiredAt = now;
  handler(message);
}
