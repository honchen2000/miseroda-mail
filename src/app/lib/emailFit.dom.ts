// 信件內文 iframe 的「解開內層捲動框」。碰 DOM → 不可被 worker 測試 import（worker tsconfig 無 DOM lib）。
// 判斷邏輯與背景說明在 emailFit.ts。
import { FIT_WRAPPER, SCROLLER_CANDIDATES, VIEWPORT_UNIT_CANDIDATES, fitZoom, isTrappingScroller, isViewportRelativeLength } from './emailFit';

function unclamp(el: HTMLElement): void {
  el.style.setProperty('height', 'auto', 'important');
  el.style.setProperty('max-height', 'none', 'important');
}

/**
 * 讓信件文件能整封攤開量高度，回傳解開了幾個內層捲動框。兩步：
 * 1. 根元素（html/body）一律解除高度限制：信件標籤上的 `height:100%` 會被解析器合併到我們的根元素，
 *    body 高度＝視窗高度＋上下內距 → 永遠比 iframe 多 28px、留一小段能上下捲的空白（iOS 實測 422 vs 394）。
 *    iframe 本來就依內容定高，根元素的高度設定對畫面沒有作用，歸零無副作用。用 setProperty 直接改寫
 *    inline 宣告，信件自帶 `!important` 也蓋得掉。min-height 同理歸零。
 * 2. 以視窗為單位的高度（100vh 之類）一律歸零：iframe 依內容定高，這種高度是循環定義（見 emailFit.ts）。
 * 3. 內層「內容超出、要自己捲」的框解除高度限制。由內往外（文件順序倒過來）：外框原本不超出（內框在捲），
 *    內框撐開後外框才超出，要接著解開。只改高度、不改 overflow：寬度超出的內容照舊可以左右捲，
 *    不會把 600px 的版型擠爛。
 */
export function unfoldEmailDocument(doc: Document): number {
  const view = doc.defaultView;
  if (!view || !doc.body) return 0;
  for (const root of [doc.documentElement, doc.body]) {
    unclamp(root);
    root.style.setProperty('min-height', '0', 'important');
  }
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>(VIEWPORT_UNIT_CANDIDATES))) {
    if (isViewportRelativeLength(el.style.getPropertyValue('height'))) el.style.setProperty('height', 'auto', 'important');
    if (isViewportRelativeLength(el.style.getPropertyValue('min-height'))) el.style.setProperty('min-height', '0', 'important');
    if (isViewportRelativeLength(el.style.getPropertyValue('max-height'))) el.style.setProperty('max-height', 'none', 'important');
  }
  const els = Array.from(doc.body.querySelectorAll<HTMLElement>(SCROLLER_CANDIDATES)).reverse();
  let n = 0;
  for (const el of els) {
    const cs = view.getComputedStyle(el);
    if (!isTrappingScroller({ overflowY: cs.overflowY, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })) continue;
    unclamp(el);
    n++;
  }
  return n;
}

/**
 * 寬版信縮放到閱讀區寬度（Hon 定案乙案），回傳套用的比例（1＝不必縮）。要在 unfoldEmailDocument 之後呼叫。
 * 1. 先清掉上次的縮放再量（轉向、拖窗格後重算）。
 * 2. 內層「左右捲」的框改成往外溢出：否則寬內容被關在框裡，外層量不到真正的版型寬度，
 *    縮完仍要在框裡左右滑。只動 auto/scroll，不碰 hidden（刻意裁切的不放出來）。
 * 3. 比例套在外層 <mr-fit>（原因見 emailFit.ts）；找不到外層就不縮。
 * 4. 最後不需要縮（放得下、或要縮太多而放棄）→ 第 2 步拆開的框還原成原本的 overflow：
 *    本來設計成「只有那張表自己左右捲」的，不該變成整封信都要左右捲（2026-09-23 審查 MEDIUM）。
 */
type SavedOverflow = [HTMLElement, string, string, string, string];
const spilled = new WeakMap<Document, SavedOverflow[]>();

function restoreSpilled(doc: Document): void {
  for (const [el, x, xp, y, yp] of spilled.get(doc) ?? []) {
    el.style.removeProperty('overflow');
    if (x) el.style.setProperty('overflow-x', x, xp);
    if (y) el.style.setProperty('overflow-y', y, yp);
  }
  spilled.delete(doc);
}

export function fitEmailToWidth(doc: Document): number {
  const view = doc.defaultView;
  const wrap = doc.querySelector<HTMLElement>(FIT_WRAPPER);
  if (!view || !wrap) return 1;
  wrap.style.removeProperty('zoom');
  restoreSpilled(doc); // 上次拆開的先還原，再依這次的寬度重新判斷
  const saved: SavedOverflow[] = [];
  const els = Array.from(wrap.querySelectorAll<HTMLElement>(SCROLLER_CANDIDATES)).reverse();
  for (const el of els) {
    const cs = view.getComputedStyle(el);
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
      // 記 longhand：原本可能只寫 overflow-x，shorthand 取回來會是空字串
      saved.push([el, el.style.getPropertyValue('overflow-x'), el.style.getPropertyPriority('overflow-x'),
        el.style.getPropertyValue('overflow-y'), el.style.getPropertyPriority('overflow-y')]);
      el.style.setProperty('overflow', 'visible', 'important');
    }
  }
  if (saved.length) spilled.set(doc, saved);
  const zoom = fitZoom(wrap.clientWidth, wrap.scrollWidth);
  if (zoom < 1) wrap.style.setProperty('zoom', String(zoom));
  else restoreSpilled(doc);
  return zoom;
}
