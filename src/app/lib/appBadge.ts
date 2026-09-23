// OS 圖示未讀角標（Badging API）。前景（App 開著）時呼叫；背景由 sw.js push handler 設。
// feature-detect + 失敗吞掉：未安裝 PWA / 不支援的瀏覽器（如目前的 Firefox）一律安靜降級。
// 只反映「收件匣未讀」（與 /counts、與推播一致）。

type Badger = Navigator & {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** 設定/清除 OS 角標。count>0 顯示數字，否則清除。 */
export function applyAppBadge(count: number): void {
  if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return;
  const nav = navigator as Badger;
  const n = Math.max(0, Math.floor(count));
  if (n > 0) void nav.setAppBadge?.(n).catch(() => {});
  else void nav.clearAppBadge?.().catch(() => {});
}
