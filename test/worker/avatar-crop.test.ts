// 頭像裁切數學：來源矩形算錯不會噴錯，只會讓頭像默默歪掉或變形，所以要有斷言守著。
import { describe, expect, it } from 'vitest';
import { clampView, coverScale, initialView, sourceRect, zoomAtPoint } from '../../src/app/lib/avatarCrop';

const VIEW = 260;
const MAX = 6;

describe('頭像裁切數學', () => {
  it('cover 縮放取長邊比例，且初始視圖置中', () => {
    // 直式手機照（本次回報的實際情境：3024×4032）
    expect(coverScale(3024, 4032, VIEW)).toBeCloseTo(260 / 3024, 10); // 寬是短邊 → 由它決定
    const v = initialView(3024, 4032, VIEW);
    expect(v.zoom).toBe(1);
    expect(v.ox).toBeCloseTo(0, 10); // 寬剛好等於取景框
    expect(v.oy).toBeLessThan(0); // 高溢出 → 往上移一半
    const s = coverScale(3024, 4032, VIEW);
    expect(v.oy).toBeCloseTo((VIEW - 4032 * s) / 2, 10);
  });

  it('位移永遠被夾住，圖片不會露出背景', () => {
    for (const [iw, ih] of [[3024, 4032], [4032, 3024], [800, 800], [5000, 1000]]) {
      const s = coverScale(iw, ih, VIEW);
      // 硬推到極端位置，兩軸都必須落在合法區間內
      for (const [ox, oy] of [[9999, 9999], [-9999, -9999], [0, 0]]) {
        const v = clampView(iw, ih, VIEW, { zoom: 1, ox, oy });
        expect(v.ox).toBeLessThanOrEqual(0);
        expect(v.oy).toBeLessThanOrEqual(0);
        expect(v.ox).toBeGreaterThanOrEqual(VIEW - iw * s - 1e-9);
        expect(v.oy).toBeGreaterThanOrEqual(VIEW - ih * s - 1e-9);
      }
    }
  });

  it('來源矩形永遠落在原圖範圍內（畫出去會變透明邊）', () => {
    const iw = 3024, ih = 4032;
    for (const zoom of [1, 1.5, 3, 6]) {
      for (const [ox, oy] of [[0, 0], [-9999, -9999], [-50, -300]]) {
        const v = clampView(iw, ih, VIEW, { zoom, ox, oy });
        const { sx, sy, side } = sourceRect(iw, ih, VIEW, v);
        expect(sx).toBeGreaterThanOrEqual(-1e-9);
        expect(sy).toBeGreaterThanOrEqual(-1e-9);
        expect(sx + side).toBeLessThanOrEqual(iw + 1e-9);
        expect(sy + side).toBeLessThanOrEqual(ih + 1e-9);
      }
    }
  });

  it('來源區塊是正方形，所以輸出不會被拉扁', () => {
    // side 同時當寬與高使用；zoom 越大取得越少（放大）
    const v1 = clampView(3024, 4032, VIEW, { zoom: 1, ox: 0, oy: -100 });
    const v3 = clampView(3024, 4032, VIEW, { zoom: 3, ox: 0, oy: -100 });
    expect(sourceRect(3024, 4032, VIEW, v1).side).toBeCloseTo(3024, 6); // zoom=1 → 取滿短邊
    expect(sourceRect(3024, 4032, VIEW, v3).side).toBeCloseTo(3024 / 3, 6);
  });

  it('焦點縮放：游標下的那一點在縮放前後對應到同一個圖片座標', () => {
    const iw = 3024, ih = 4032;
    const start = initialView(iw, ih, VIEW);
    const fx = 200, fy = 60; // 刻意不取中心
    const before = sourceRect(iw, ih, VIEW, start);
    const uBefore = before.sx + (fx / VIEW) * before.side;
    const wBefore = before.sy + (fy / VIEW) * before.side;

    const zoomed = zoomAtPoint(iw, ih, VIEW, start, fx, fy, 2.5, MAX);
    const after = sourceRect(iw, ih, VIEW, zoomed);
    const uAfter = after.sx + (fx / VIEW) * after.side;
    const wAfter = after.sy + (fy / VIEW) * after.side;

    expect(uAfter).toBeCloseTo(uBefore, 6);
    // y 軸此例未被夾住，同樣應維持不動
    expect(wAfter).toBeCloseTo(wBefore, 6);
  });

  it('縮放倍率被夾在 1..max：不能縮到露出背景，也不能無限放大', () => {
    const start = initialView(3024, 4032, VIEW);
    expect(zoomAtPoint(3024, 4032, VIEW, start, 130, 130, 0.2, MAX).zoom).toBe(1);
    expect(zoomAtPoint(3024, 4032, VIEW, start, 130, 130, 99, MAX).zoom).toBe(MAX);
  });
});
