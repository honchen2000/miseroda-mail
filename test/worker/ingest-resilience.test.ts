// F18.1：解碼韌性。
// 背景（2026-09-20 查證）：consumer 的 PostalMime.parse 與 sanitizeEmailHtml 原本沒有任何保護，
// 丟例外的下場是「重試 5 次 → DLQ → DLQ 沒有 consumer 沒人知道 → r2_html_key 永遠不回填 → 前端永遠『處理中』」。
// 正式庫至今 0 次發生（175/175 入站信皆有內文、error_log 無 ingest 失敗），這裡釘的是那 0.01% 的失敗模式：
// (1) 消毒失敗要退成純文字並誠實標示；(2) DLQ 要有人接、落 error_log、ack 不重試。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { degradedBody } from '../../src/worker/jobs/ingestConsumer';

describe('解碼韌性（F18.1）', () => {
  it('degradedBody：純文字退路帶頂端提示、內容有 escape、不帶遠端圖', () => {
    const { html, hasRemoteImages } = degradedBody('Hi <b>bold</b> & "quotes"\n\n第二段');
    expect(hasRemoteImages).toBe(false);
    expect(html).toContain('無法安全解析');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; "quotes"'); // 使用者內容一律 escape
    expect(html).toContain('<p>第二段</p>');
    expect(html).not.toContain('<b>bold</b>');
    expect(degradedBody(undefined).html).toContain('沒有可顯示的純文字內容');
    expect(degradedBody('   ').html).toContain('沒有可顯示的純文字內容');
  });

  it('DLQ 有人接：每則落 error_log（scope=dlq.<kind>）並 ack，零重試', async () => {
    const batch = createMessageBatch('miseroda-dlq', [
      { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'ingest', messageId: 'msg-x', userId: 'usr-x' }, attempts: 6 },
      { id: crypto.randomUUID(), timestamp: new Date(), body: null, attempts: 6 }, // 壞 body 也不能讓 consumer 爆
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const res = await getQueueResult(batch, ctx);
    expect(res.retryMessages.length).toBe(0);
    expect(res.ackAll || res.explicitAcks.length === 2).toBe(true);
    const rows = await env.DB.prepare(`SELECT scope, meta FROM error_log WHERE scope LIKE 'dlq.%' ORDER BY scope`)
      .all<{ scope: string; meta: string | null }>();
    expect(rows.results.map((r) => r.scope)).toEqual(['dlq.ingest', 'dlq.unknown']);
    expect(rows.results[0].meta).toContain('msg-x'); // 帶原 job 內容，管理頁看得出是哪封
  });
});
