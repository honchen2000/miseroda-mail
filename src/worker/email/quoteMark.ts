// F13.1：讀信引文標記——serve 時（GET /messages/:id）把「明確的回覆引文容器」加上 data-quote，
// 前端顯示層用 CSS 摺疊。不動 R2 儲存的 HTML，老信每次讀取都會被標到。
// 精準優先（防過度摺疊）：只標記回覆專用標記，不動一般 blockquote——電子報排版常用 blockquote，
// 誤標會把正文摺掉。誠實邊界：Outlook 的 #divRplyFwdMsg 是「分隔線＋後續兄弟節點」結構，
// HTMLRewriter 標不到兄弟節點，此類信不摺（顯示全文，無資料損失）。

const QUOTE_SELECTORS = [
  'div.gmail_quote', // Gmail 系（含 gmail_quote_container 內層，外層命中即可）
  'blockquote[type="cite" i]', // Apple Mail / Thunderbird 回覆引文
];

export async function markQuotedHtml(html: string): Promise<{ html: string; hasQuote: boolean }> {
  if (!html || !/gmail_quote|<blockquote/i.test(html)) return { html, hasQuote: false }; // 快速路徑：多數信無引文
  let hasQuote = false;
  let rewriter = new HTMLRewriter();
  for (const sel of QUOTE_SELECTORS) {
    rewriter = rewriter.on(sel, {
      element(el) {
        hasQuote = true;
        el.setAttribute('data-quote', '1');
      },
    });
  }
  const out = await rewriter.transform(new Response(html)).text();
  return { html: out, hasQuote };
}
