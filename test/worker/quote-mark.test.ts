// F13.1：引文標記——markQuotedHtml 正反例 + /messages/:id serve 整合。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { markQuotedHtml } from '../../src/worker/email/quoteMark';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

describe('F13.1 markQuotedHtml', () => {
  it('Gmail gmail_quote 與 Apple blockquote[type=cite]（含大小寫）標 data-quote；hasQuote=true', async () => {
    const gmail = await markQuotedHtml('<p>新內容</p><div class="gmail_quote">舊信</div>');
    expect(gmail.hasQuote).toBe(true);
    expect(gmail.html).toContain('data-quote="1"');
    expect(gmail.html).toContain('<p>新內容</p>'); // 正文不動
    const apple = await markQuotedHtml('<p>hi</p><blockquote TYPE="CITE"><p>舊信</p></blockquote>');
    expect(apple.hasQuote).toBe(true);
    expect(apple.html).toMatch(/<blockquote[^>]*data-quote="1"/i);
  });

  it('反例：一般 blockquote（電子報排版）不標、無引文信原樣通過、空字串安全', async () => {
    const news = await markQuotedHtml('<blockquote><p>本週金句</p></blockquote>');
    expect(news.hasQuote).toBe(false);
    expect(news.html).not.toContain('data-quote');
    const plain = await markQuotedHtml('<p>沒有引文的信</p>');
    expect(plain).toEqual({ html: '<p>沒有引文的信</p>', hasQuote: false });
    expect(await markQuotedHtml('')).toEqual({ html: '', hasQuote: false });
  });

  it('/messages/:id serve：R2 html 被標記且回 hasQuote 欄位（老信也涵蓋）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const now = Date.now();
    await env.MAIL_STORE.put('html/test-quote', '<p>回覆正文</p><div class="gmail_quote">上一封</div>');
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, subject, snippet, folder, is_read, r2_html_key, received_at, created_at)
       VALUES ('mq1', ?, 't-mq1', 'inbound', 'a@b.c', 'Re: 話題', '', 'inbox', 0, 'html/test-quote', ?, ?)`,
    )
      .bind(hon.userId, now, now)
      .run();
    const res = await worker.fetch(
      new Request(`${BASE}/messages/mq1`, {
        headers: {
          Cookie: `__Host-session=${encodeURIComponent(hon.cookies.session)}; __Host-csrf=${encodeURIComponent(hon.cookies.csrf)}`,
          'X-CSRF-Token': hon.cookies.csrf,
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ thread: { id: string; html: string; hasQuote: boolean }[] }>();
    const msg = data.thread.find((t) => t.id === 'mq1')!;
    expect(msg.hasQuote).toBe(true);
    expect(msg.html).toContain('data-quote="1"');
  });
});
