// F11.4：自訂主題純函式（hex 解析 / 亮度 / 派生變數）——DOM 套用層不在 workerd 測。
import { describe, expect, it } from 'vitest';
import { deriveAccentVars, isLightColor, parseHex } from '../../src/app/lib/customTheme';

describe('F11.4 自訂主題純函式', () => {
  it('parseHex：合法 6 位 hex（含無 #）；垃圾回 null', () => {
    expect(parseHex('#5FF6C2')).toEqual({ r: 95, g: 246, b: 194 });
    expect(parseHex('0a0e1a')).toEqual({ r: 10, g: 14, b: 26 });
    expect(parseHex('#fff')).toBeNull();
    expect(parseHex('red')).toBeNull();
  });

  it('isLightColor：亮色 accent 配深字、暗色配淺字', () => {
    expect(isLightColor('#5FF6C2')).toBe(true); // 極光綠 → 深字
    expect(isLightColor('#1A2235')).toBe(false); // 深藍 → 淺字
  });

  it('deriveAccentVars：soft/glow rgba 派生 + ink 依亮度；壞輸入 null', () => {
    const v = deriveAccentVars('#5FF6C2')!;
    expect(v['--accent']).toBe('#5ff6c2');
    expect(v['--accent-soft']).toBe('rgba(95, 246, 194, 0.14)');
    expect(v['--accent-glow']).toBe('rgba(95, 246, 194, 0.25)');
    expect(v['--accent-ink']).toBe('#0A0E1A');
    expect(deriveAccentVars('nope')).toBeNull();
  });
});
