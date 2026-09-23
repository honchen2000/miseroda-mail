// F11.4：自訂主題的 DOM 套用層（worker tsconfig 無 DOM lib → 與純函式分檔，讓 worker 測試可 import 純模組）。
import { deriveAccentVars, parseHex, type CustomTheme } from './customTheme';

/** 套用/清除自訂主題（documentElement inline 變數——優先於 data-accent 的 class 定義）。 */
export function applyCustomTheme(t: CustomTheme | null | undefined): void {
  const el = document.documentElement;
  const keys = ['--accent', '--accent-soft', '--accent-glow', '--accent-ink', '--bg-base'];
  for (const k of keys) el.style.removeProperty(k);
  if (!t) return;
  if (t.accent) {
    const vars = deriveAccentVars(t.accent);
    if (vars) for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  }
  if (t.bg && parseHex(t.bg)) el.style.setProperty('--bg-base', t.bg);
}
