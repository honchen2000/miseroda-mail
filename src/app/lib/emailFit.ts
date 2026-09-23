// 信件內文「被關進小框自己捲」的判斷（2026-09-23 Hon 手機實機回報）。純函式 → 可被 worker vitest 單測。
// 接線在 emailFit.dom.ts（碰 DOM）與 mail.tsx EmailBody（量高度前先解開）。
//
// 症狀：某些信在手機上只剩一小塊，要在裡面用手指上下左右滑。
// 根因（iOS 模擬器真 WebKit 重現）：信件自帶 `<html style="height:100%">`／`<body style="height:100%">`
// （消毒器只擋了 <style> 裡的 body/html 規則，**寫在標籤上的 style 會被解析器合併到我們的根元素**），
// 再包一層 `height:100%`（或 `100vh`）＋`overflow:auto` 的容器 → 那個容器的高度等於 iframe 當下的
// 視窗高度（初始 80px），內容在它裡面捲；我們量 body.scrollHeight 只量得到框的高度 → iframe 定在小小一塊。
//
// 解法：量高度前，把「可捲（auto/scroll）且內容確實超出可視高度」的容器解除高度限制，讓內容自然撐開。
// 刻意**不碰 overflow:hidden**：很多信用 `max-height:0;overflow:hidden` 藏預覽文字（preheader），
// 打開會露出本來就不該看到的字。

export interface ScrollBoxState {
  /** getComputedStyle(el).overflowY */
  overflowY: string;
  scrollHeight: number;
  clientHeight: number;
}

/** 這個元素是不是「把內容關在裡面、要使用者自己捲」的框？ */
export function isTrappingScroller(s: ScrollBoxState): boolean {
  return (s.overflowY === 'auto' || s.overflowY === 'scroll') && s.scrollHeight > s.clientHeight + 1;
}

/**
 * 候選元素的選擇器。消毒器會把 <style> 規則全部內聯到 style 屬性、<style> 本身丟掉，
 * 我們自己的樣式表也沒有設任何 auto/scroll → 能造成內層捲動的一定寫在 style 屬性裡。
 * 只看這些元素，長信（上千個元素）也不必逐一 getComputedStyle。
 */
export const SCROLLER_CANDIDATES = '[style*="overflow" i]';

/**
 * 高度值是否以「視窗」為單位（vh／svh／lvh／dvh／vmin／vmax／vb，含 calc 裡的）。iframe 依內容定高，
 * 視窗高度又等於我們設的 iframe 高 → 這種高度是循環定義：iframe 已經比內容高時（換內容、按載入圖片後），
 * `100vh` 的框沒「超出」、不會被當成捲動框解開，卻把 iframe 撐成「視窗高＋內距」，每重算一次再長 36px
 * （iOS 實測 1044→1080→1116）。vw 只跟寬度有關、我們不改寬 → 不算。
 */
export function isViewportRelativeLength(value: string): boolean {
  return /\d(?:[sld]?vh|[sld]?vmin|[sld]?vmax|[sld]?vb)\b/i.test(value);
}

/** 可能寫了視窗單位的元素（同 SCROLLER_CANDIDATES，一律在 style 屬性裡）。 */
export const VIEWPORT_UNIT_CANDIDATES = '[style*="vh" i], [style*="vmin" i], [style*="vmax" i], [style*="vb" i]';

// ---- 寬版信縮放到螢幕寬（2026-09-23 Hon 定案乙案：Apple Mail／Gmail 做法） ----
// 比閱讀區還寬的信（常見 600px 版型）整封等比縮小到剛好一個寬度，不必左右滑；要看細節用兩指放大。
// 桌機只有在讀信窗格比信還窄時才會縮。
//
// 縮放套在包住信件的外層 <mr-fit>，**不套在 body**（iOS 模擬器實測）：WebKit 對縮放中的 body 回報的
// scrollHeight／getBoundingClientRect 都是縮放前的數字（287 vs 實際 167），拿來設高度底部會多出一大段空白；
// 改讀根元素又最小只會是 iframe 當下的高度，縮不回來。body 不縮、只縮外層 → body.scrollHeight 就是視覺高度。
// 外層用自訂標籤：信件裡多出來的 </div> 關不掉它；消毒器會拆掉信件裡的未知標籤，偽造不出同名元素。

/** buildSrcdoc 包住信件內容的外層標籤（樣式表設 display:flow-root，把浮動的 table／img 包進來）。 */
export const FIT_WRAPPER = 'mr-fit';

/**
 * 低於這個比例就乾脆不縮：那通常不是固定寬的版型，而是一整行不換行的長字串之類的異常，
 * 整封縮到這麼小反而全部看不到字（實測 0.3 時一般段落只剩約 4px）；不縮則只有那一行要左右捲。
 * 0.4 在 iPhone（內文區約 340px）可容納到約 850px 寬的版型，常見 600～800px 都在範圍內。
 */
export const MIN_FIT_ZOOM = 0.4;

/** 版型寬 needed 要放進可用寬 available 需要的縮放比例；本來就放得下（含 1px 捨入）或需要縮太多都回 1。 */
export function fitZoom(available: number, needed: number): number {
  if (available <= 0 || needed <= available + 1) return 1;
  const z = available / needed;
  return z < MIN_FIT_ZOOM ? 1 : z;
}

/** 寬度真的變了才需要重新縮放（轉向、拖窗格）；我們自己改高度觸發的 ResizeObserver 不算。 */
export function widthChanged(lastWidth: number | null, width: number): boolean {
  return width > 0 && (lastWidth === null || Math.abs(width - lastWidth) >= 1);
}

/** 上次（last）與上上次（prev）攤開／縮放時的 iframe 寬，以及上次的時間（ms）。 */
export interface FitWidthState {
  last: number | null;
  prev: number | null;
  at: number;
}
export const EMPTY_FIT_WIDTH: FitWidthState = { last: null, prev: null, at: 0 };

/** 寬度在這段時間內「彈回上上次的寬度」視為振盪。 */
export const OSCILLATION_WINDOW_MS = 1000;

/**
 * ResizeObserver 觸發時要不要重算。寬度沒變 → 不算。
 * 振盪保險（2026-09-23 審查 HIGH）：開著「永遠顯示捲軸」時，信件高度若剛好卡在讀信窗格要不要出捲軸的門檻，
 * 捲軸出現 → iframe 窄 12px → 重縮變矮 → 捲軸消失 → 變寬 → 重縮變高 → 捲軸又出現……無限閃爍。
 * 根本解是讀信窗格的 scrollbar-gutter: stable（寬度不隨捲軸變）；這裡是其他未知來源的保險：
 * 1 秒內**彈回較寬**的上上次寬度 → 略過。用較窄寬度算出的比例放進較寬的空間一定放得下，不會被切；
 * 彈回**較窄**的一邊則照常重算（否則會溢出）——兩種起始順序最多 3 次重算就停住；快速轉回直向（變窄）也照常重算。
 */
export function shouldRefitWidth(s: FitWidthState, width: number, now: number): boolean {
  if (!widthChanged(s.last, width)) return false;
  const bouncingBack = s.prev !== null && Math.abs(width - s.prev) < 1 && now - s.at < OSCILLATION_WINDOW_MS;
  return !(bouncingBack && s.last !== null && width > s.last);
}

/** 記下這次攤開／縮放時的寬度（寬 0＝沒有版面，不記）。 */
export function recordFitWidth(s: FitWidthState, width: number, now: number): FitWidthState {
  if (width <= 0) return s;
  if (s.last !== null && Math.abs(width - s.last) < 1) return { ...s, at: now };
  return { last: width, prev: s.last, at: now };
}
