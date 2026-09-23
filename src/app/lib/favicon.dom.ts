// 分頁圖示未讀紅點（F21.3）。碰 document/canvas/Image → 不進 worker 測試。
//
// 為什麼要整組換掉 <link rel=icon> 而不是改 href：index.html 掛了三個圖示
// （svg / 32 / 16），瀏覽器挑哪一個是它自己的事——只改其中一個會看不出變化，
// 而把 PNG data URL 塞進 type="image/svg+xml" 的那個又會壞掉。
// 所以加紅點時把原本那組整個取下、換上單一 PNG，清除時再原樣放回去。
//
// 紅點刻意不畫數字：16px 的圖示上數字根本看不清，數量已經在分頁標題 `(3)` 與
// OS 角標上了，這裡只負責「有沒有」。

const BASE_ICON = '/favicon-32.png';
const SIZE = 32;

let originals: HTMLLinkElement[] | null = null; // 取下來的原始 link（清除時放回）
let badged: HTMLLinkElement | null = null;
let badgedUrl: string | null = null; // 畫好的 data URL，只需畫一次
let building = false;
// 目前「應該」是什麼狀態。畫圖是非同步的，期間未讀可能已經歸零——
// 沒有這個旗標，遲到的那次 then() 會把紅點補上去，變成已讀了還掛著紅點。
let desired = false;

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

/** 畫一次「原圖 + 右上紅點」；失敗（canvas 不可用等）回 null，呼叫端安靜降級。 */
async function buildBadgedIcon(): Promise<string | null> {
  if (badgedUrl) return badgedUrl;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('icon load failed'));
      el.src = BASE_ICON; // 同源，不會污染 canvas
    });
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    // 紅點外圍留一圈底色，深淺主題與各家分頁列背景都看得出輪廓。
    ctx.beginPath();
    ctx.arc(SIZE - 9, 9, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(SIZE - 9, 9, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    badgedUrl = canvas.toDataURL('image/png');
    return badgedUrl;
  } catch {
    return null;
  }
}

/** 未讀 > 0 → 圖示加紅點；歸零 → 還原原本那組圖示。重複呼叫同一狀態不做事。 */
export function applyFaviconBadge(unread: number): void {
  if (typeof document === 'undefined') return;
  desired = unread > 0;
  if (desired === (badged !== null)) return;

  if (!desired) {
    badged?.remove();
    badged = null;
    for (const link of originals ?? []) document.head.appendChild(link);
    originals = null;
    return;
  }

  if (building) return; // 前一次還在載圖，別疊第二次
  building = true;
  void buildBadgedIcon()
    .then((url) => {
      building = false;
      // 這期間可能已經被標回已讀 → 不要硬套上去
      if (!url || !desired || badged !== null) return;
      originals = iconLinks();
      for (const link of originals) link.remove();
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = url;
      document.head.appendChild(link);
      badged = link;
    })
    .catch(() => {
      building = false;
    });
}
