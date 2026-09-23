// F5.5：回覆引文組裝（純函式，無 DOM，可在 worker env 測）。
// 有選取段落 → 只引用該段；否則沿用既有「整封引用」。

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface QuotedReply {
  /** 純文字引文：每行前綴 "> "。 */
  quotedText: string;
  /** 富文本引文：<blockquote>…</blockquote>。 */
  quoteHtml: string;
  /** 是否來自使用者選取的段落（true）還是整封（false）。 */
  fromSelection: boolean;
}

/** F13.1：清掉 serve 端標的 data-quote 顯示屬性——別讓它跟著回覆/轉寄寄出去（語意噪音）。 */
export function stripQuoteMarks(html: string): string {
  return html.replace(/\sdata-quote="1"/g, '');
}

const FULL_TEXT_MAX_LINES = 60; // 整封引用上限（沿用既有 replyToMsg）
const SELECTION_MAX_LINES = 500; // 選取段落上限（保護極端貼上）

/**
 * 組裝回覆引文。
 * @param fullText 原信純文字（DOMParser textContent）
 * @param fullHtml 原信消毒後 HTML（整封引用時用）
 * @param selection 使用者於閱讀窗選取的純文字（trim 後非空才生效）
 */
export function buildQuotedReply(opts: { fullText: string; fullHtml: string; selection?: string | null }): QuotedReply {
  const sel = (opts.selection ?? '').trim();
  if (sel) {
    const lines = sel.split('\n');
    const quotedText = lines.slice(0, SELECTION_MAX_LINES).map((l) => `> ${l}`).join('\n');
    // 選取只有純文字 → 逐行 escape + <br>（空行給 <br> 維持段距）；安全（純文字、無原始 HTML）。
    const quoteHtml = `<blockquote>${lines
      .slice(0, SELECTION_MAX_LINES)
      .map((l) => escapeHtml(l) || '<br>')
      .join('<br>')}</blockquote>`;
    return { quotedText, quoteHtml, fromSelection: true };
  }
  const quotedText = opts.fullText
    .split('\n')
    .slice(0, FULL_TEXT_MAX_LINES)
    .map((l) => `> ${l}`)
    .join('\n');
  return { quotedText, quoteHtml: `<blockquote>${stripQuoteMarks(opts.fullHtml)}</blockquote>`, fromSelection: false };
}
