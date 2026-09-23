// 頭像裁切的純數學（不碰 DOM，可在 worker 測試環境 import——比照 platform.ts / customTheme.ts 的拆檔法）。
//
// 座標系：取景框是邊長 view 的正方形，左上角為 (0,0)。
// 圖片以 coverScale × zoom 等比放大後，左上角放在 (ox, oy)。zoom = 1 代表剛好蓋滿取景框。

export interface CropView {
  zoom: number;
  ox: number;
  oy: number;
}

/** 讓圖片剛好蓋滿取景框所需的縮放（cover，非 contain——頭像不能留白邊）。 */
export function coverScale(iw: number, ih: number, view: number): number {
  return Math.max(view / iw, view / ih);
}

/** 夾住位移，使圖片永遠完全覆蓋取景框。 */
export function clampView(iw: number, ih: number, view: number, v: CropView): CropView {
  const s = coverScale(iw, ih, view) * v.zoom;
  const dw = iw * s;
  const dh = ih * s;
  return {
    zoom: v.zoom,
    ox: Math.min(0, Math.max(view - dw, v.ox)),
    oy: Math.min(0, Math.max(view - dh, v.oy)),
  };
}

/** 置中的初始視圖。 */
export function initialView(iw: number, ih: number, view: number): CropView {
  const s = coverScale(iw, ih, view);
  return { zoom: 1, ox: (view - iw * s) / 2, oy: (view - ih * s) / 2 };
}

/**
 * 以取景框內的 (fx, fy) 為焦點縮放到 nextZoom，讓該點下的影像內容維持不動
 * （滾輪縮放與雙指捏合都靠這個，否則畫面會往角落飄）。
 */
export function zoomAtPoint(
  iw: number, ih: number, view: number, v: CropView,
  fx: number, fy: number, nextZoom: number, maxZoom: number,
): CropView {
  const z = Math.min(maxZoom, Math.max(1, nextZoom));
  const base = coverScale(iw, ih, view);
  const s0 = base * v.zoom;
  const s1 = base * z;
  // 焦點在圖片座標中的位置，縮放前後必須相同
  const u = (fx - v.ox) / s0;
  const w = (fy - v.oy) / s0;
  return clampView(iw, ih, view, { zoom: z, ox: fx - u * s1, oy: fy - w * s1 });
}

/** 取景框對應到原圖座標的方形來源區塊，供 ctx.drawImage 使用。 */
export function sourceRect(iw: number, ih: number, view: number, v: CropView): { sx: number; sy: number; side: number } {
  const s = coverScale(iw, ih, view) * v.zoom;
  return { sx: -v.ox / s, sy: -v.oy / s, side: view / s };
}
