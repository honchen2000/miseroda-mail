// F4.4：簽名渲染（純函式，可被 worker vitest 測）。
// 內容存純文字 → 套用時 escape + nl2br，包成 [data-sig] 區塊，供撰寫器切身分時定位/抽換（避免 XSS）。
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

/** 文字簽名 → 標記的 HTML 區塊（空內容→空字串）。 */
export function signatureBlockHtml(content: string): string {
  const t = content.trim();
  if (!t) return '';
  return `<div data-sig="1">${esc(t).replace(/\n/g, '<br>')}</div>`;
}

/** 純文字 body 用的簽名（前置兩個換行；空→空字串）。 */
export function signatureText(content: string): string {
  const t = content.trim();
  return t ? `\n\n${t}` : '';
}
