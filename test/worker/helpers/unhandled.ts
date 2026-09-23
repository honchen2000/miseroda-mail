// 收集測試期間的 unhandled rejection。
// ⚠️ vitest-pool-workers **不會**因為 unhandled rejection 讓測試失敗（2026-09-22 紅測實證：
// 拿掉 catch 後測試照樣通過）——要守「不可漏接」就必須像這樣自己攔、自己斷言。
// workerd 支援全域的 `unhandledrejection` 事件（Workers runtime 的標準 EventTarget）。

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 執行 fn，回傳期間發生的 unhandled rejection 原因清單（多等幾輪讓 microtask／事件跑完）。 */
export async function collectUnhandledRejections(fn: () => unknown | Promise<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (ev: Event) => {
    const e = ev as Event & { reason?: unknown; preventDefault(): void };
    seen.push(e.reason);
    e.preventDefault(); // 已記錄，別讓 runtime 再印一次
  };
  addEventListener('unhandledrejection', onRejection);
  try {
    await fn();
    for (let i = 0; i < 5; i++) await flush();
  } finally {
    removeEventListener('unhandledrejection', onRejection);
  }
  return seen;
}
