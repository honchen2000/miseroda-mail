// 版本標籤：頭像選單最底下的一行小字（2026-09-23 Hon 定案甲案）。純函式 → 可被 worker vitest 單測。
// 讓 Hon 在 PWA 裡確認「現在跑的是哪一版」，對照每次上線回報的 commit 編號。
// 用 commit 編號＋commit 時間（不用建置時間）：同一個 commit 建出來的產物才會一模一樣，
// 「比對線上與本機程式檔」的上線驗證才不會失效。值由 vite.config.ts 在建置時注入（buildInfo.ts）。

/** 「版本 09/23 09:58 · 4231ac2」；時間不合法就只顯示編號。timeZone 省略＝裝置所在時區。 */
export function formatBuildLabel(sha: string, isoTime: string, timeZone?: string): string {
  const short = sha.slice(0, 7) || 'dev';
  const d = new Date(isoTime);
  if (!isoTime || Number.isNaN(d.getTime())) return `版本 ${short}`;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `版本 ${get('month')}/${get('day')} ${get('hour')}:${get('minute')} · ${short}`;
}
