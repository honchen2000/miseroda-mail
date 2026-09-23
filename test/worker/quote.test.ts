// F5.5：回覆引文組裝純函式（無 DOM，可在 worker env 測）。
import { describe, expect, it } from 'vitest';
import { buildQuotedReply } from '../../src/app/lib/quote';

describe('buildQuotedReply（F5.5 回覆引文）', () => {
  it('無選取 → 引用整封（前綴 > + 整封 HTML blockquote）', () => {
    const r = buildQuotedReply({ fullText: '第一行\n第二行', fullHtml: '<p>第一行</p><p>第二行</p>', selection: '' });
    expect(r.fromSelection).toBe(false);
    expect(r.quotedText).toBe('> 第一行\n> 第二行');
    expect(r.quoteHtml).toBe('<blockquote><p>第一行</p><p>第二行</p></blockquote>'); // 整封用原 HTML
  });

  it('有選取 → 只引用選取段落（純文字 + 逐行 escape 的 blockquote）', () => {
    const r = buildQuotedReply({ fullText: '整封很長…', fullHtml: '<p>整封很長…</p>', selection: '只要這段\n還有這行' });
    expect(r.fromSelection).toBe(true);
    expect(r.quotedText).toBe('> 只要這段\n> 還有這行');
    expect(r.quoteHtml).toBe('<blockquote>只要這段<br>還有這行</blockquote>');
  });

  it('選取含 HTML 特殊字元 → escape（不注入）', () => {
    const r = buildQuotedReply({ fullText: 'x', fullHtml: '<p>x</p>', selection: '<script>alert(1)</script> & "q"' });
    expect(r.quoteHtml).toBe('<blockquote>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</blockquote>');
    expect(r.quoteHtml).not.toContain('<script>');
  });

  it('只有空白的選取 → 視為無選取（引用整封）', () => {
    const r = buildQuotedReply({ fullText: '全文', fullHtml: '<p>全文</p>', selection: '   \n  ' });
    expect(r.fromSelection).toBe(false);
    expect(r.quoteHtml).toContain('<p>全文</p>');
  });

  it('null 選取 → 引用整封', () => {
    const r = buildQuotedReply({ fullText: '全文', fullHtml: '<p>全文</p>', selection: null });
    expect(r.fromSelection).toBe(false);
  });

  it('F13.1：整封引用時清掉 serve 端的 data-quote 顯示屬性（不跟著寄出去）', () => {
    const r = buildQuotedReply({
      fullText: '全文',
      fullHtml: '<p>正文</p><div class="gmail_quote" data-quote="1">舊引文</div>',
      selection: null,
    });
    expect(r.quoteHtml).not.toContain('data-quote');
    expect(r.quoteHtml).toContain('class="gmail_quote"'); // 只拔屬性，結構不動
  });
});
