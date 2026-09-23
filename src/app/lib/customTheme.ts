// F11.4：自訂主題——取色器改 accent / 背景色，直接覆寫 CSS 變數（存 prefs.customTheme 跨裝置同步）。
// 純函式（hex 解析/亮度/派生色）與 DOM 套用分離，前者可在 worker 測試環境直測。

export interface CustomTheme {
  accent?: string; // #rrggbb
  bg?: string; // #rrggbb（覆寫 --bg-base）
}

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 相對亮度（WCAG 簡化）→ 決定 accent 上的字用深或淺。 */
export function isLightColor(hex: string): boolean {
  const c = parseHex(hex);
  if (!c) return false;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.55;
}

/** accent hex → 需要覆寫的變數組（soft/glow 以 rgba 派生，ink 依亮度選字色）。 */
export function deriveAccentVars(hex: string): Record<string, string> | null {
  const c = parseHex(hex);
  if (!c) return null;
  const rgb = `${c.r}, ${c.g}, ${c.b}`;
  return {
    '--accent': `#${((c.r << 16) | (c.g << 8) | c.b).toString(16).padStart(6, '0')}`,
    '--accent-soft': `rgba(${rgb}, 0.14)`,
    '--accent-glow': `rgba(${rgb}, 0.25)`,
    '--accent-ink': isLightColor(hex) ? '#0A0E1A' : '#F5F7FB',
  };
}
