// F17.1：撰寫視窗的純邏輯（無 DOM、無 React）。
// 抽成獨立模組的理由：worker tsconfig 沒有 DOM lib，測試不能 import App.tsx；
// 拆檔法沿用既有先例（platform.dom.ts / customTheme.dom.ts 的作法，方向相反但道理相同）。

/** enforceExpandLimit 只看得到這三個欄位；App 的 ComposerWin 結構上即滿足。 */
export interface ComposerWinLike {
  key: string;
  minimized: boolean;
  /** 最近互動時間：越舊越先被收起。 */
  activeAt: number;
}

/**
 * 展開數超過上限 → 把最久沒互動的那幾扇收起（Gmail 行為：開第 N+1 扇時最舊的那扇自動縮成晶片）。
 * 沒超過上限時原樣回傳同一個陣列參考（避免無謂的 re-render）。
 * 已經收起的視窗一律不動——只在「展開中」這個集合裡挑。
 */
export function enforceExpandLimit<T extends ComposerWinLike>(ws: T[], max: number): T[] {
  const expanded = ws.filter((w) => !w.minimized).sort((a, b) => b.activeAt - a.activeAt);
  if (expanded.length <= max) return ws;
  const demote = new Set(expanded.slice(max).map((w) => w.key));
  return ws.map((w) => (demote.has(w.key) ? { ...w, minimized: true } : w));
}
