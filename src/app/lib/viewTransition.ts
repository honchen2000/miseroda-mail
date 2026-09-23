// View Transition 的「被略過」不是錯誤（2026-09-22，Hon 回報 console 出現
// `Uncaught (in promise) AbortError: Transition was skipped`）。
// 純函式、不碰 DOM → 可被 worker vitest 單測。
//
// 上一個過場還沒結束就開始下一個（連點、j/k 連續換信）、或分頁隱藏時，瀏覽器會略過過場：
// 畫面照常更新（update callback 仍會執行），只是少一次動畫——但 `ready` 會 reject AbortError，
// 沒人接住就變成 console 的 Uncaught (in promise)。
//
// **刻意只接 `ready`**：`finished`／`updateCallbackDone` 的 reject 代表畫面更新本身（apply）出錯，
// 那是真錯誤，吞掉會把 bug 藏起來。

export interface TransitionLike {
  ready?: Promise<unknown>;
  finished?: Promise<unknown>;
}

export function ignoreSkippedTransition(t: TransitionLike | null | undefined | void): void {
  if (t && t.ready) t.ready.catch(() => {});
}
