// F10.3：帳單/包裹卡 —— 清洗容錯（純函式）/ ingest 抽取存欄 / 非收據信不燒 AI。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';
import { looksLikeReceipt, sanitizeReceiptCard } from '../../src/worker/lib/receiptCard';

async function deliverAndIngest(userId: string, subject: string, body: string, aiEnv: typeof env): Promise<string> {
  const deliverEnv = { ...aiEnv, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
  await worker.email(
    mockEmailMessage(plainEmail({ subject, body, to: 'hon@miseroda.com' }), { from: 'billing@shop.com', to: 'hon@miseroda.com' }).message,
    deliverEnv,
    createExecutionContext(),
  );
  const row = await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(userId)
    .first<{ id: string }>();
  const id = row!.id;
  const batch = createMessageBatch('miseroda-ingest', [
    { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'ingest', messageId: id, userId }, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, aiEnv, ctx);
  await getQueueResult(batch, ctx);
  return id;
}

const cardOf = (id: string) =>
  env.DB.prepare(`SELECT receipt_card FROM messages WHERE id = ?`).bind(id).first<{ receipt_card: string | null }>();

describe('F10.3 帳單/包裹卡', () => {
  it('sanitizeReceiptCard 容錯：合法欄位保留、髒欄位丟棄、全空/非法 kind 回 null', () => {
    expect(sanitizeReceiptCard({ kind: 'bill', amount: 'NT$ 1,234', dueDate: '2026-07-15', vendor: '台電' }))
      .toEqual({ kind: 'bill', amount: 'NT$ 1,234', dueDate: '2026-07-15', vendor: '台電' });
    // 髒欄位逐一丟棄：無數字金額 / 非 ISO 日期 / 太短追蹤號
    expect(sanitizeReceiptCard({ kind: 'parcel', amount: '未知', dueDate: '7月15日', trackingNo: 'AB12', vendor: '黑貓' })).toBeNull(); // 全部被丟 → null
    expect(sanitizeReceiptCard({ kind: 'parcel', trackingNo: 'sf1234567890tw' }))
      .toEqual({ kind: 'parcel', trackingNo: 'SF1234567890TW' }); // 追蹤號轉大寫
    expect(sanitizeReceiptCard({ kind: 'refund', amount: 'NT$ 99' })).toBeNull(); // 非法 kind
    expect(sanitizeReceiptCard('not-an-object')).toBeNull();
    expect(sanitizeReceiptCard({ kind: 'bill', dueDate: '2026-13-99' })).toBeNull(); // 假日期
  });

  it('looksLikeReceipt：主旨關鍵字命中（中英）', () => {
    expect(looksLikeReceipt('您的 7 月帳單已產生')).toBe(true);
    expect(looksLikeReceipt('Your order has shipped — receipt inside')).toBe(true);
    expect(looksLikeReceipt('週五聚餐')).toBe(false);
  });

  it('ingest：收據信 → AI 抽取（json_schema）→ 清洗後存 receipt_card；AI 回髒資料 → 不存', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const good = ({ ...env, AI: { run: async () => ({ response: JSON.stringify({ kind: 'bill', amount: 'NT$ 940', dueDate: '2026-07-15', vendor: '台灣電力' }) }) } }) as unknown as typeof env;
    const id = await deliverAndIngest(hon.userId, '7 月電費帳單', '本期應繳 940 元，繳費期限 2026/07/15，逾期將加收費用。', good);
    const row = await cardOf(id);
    expect(JSON.parse(row!.receipt_card!)).toEqual({ kind: 'bill', amount: 'NT$ 940', dueDate: '2026-07-15', vendor: '台灣電力' });

    const dirty = ({ ...env, AI: { run: async () => ({ response: 'oops not json {' }) } }) as unknown as typeof env;
    const id2 = await deliverAndIngest(hon.userId, '8 月帳單', '本期應繳 1,000 元整，繳費期限下月中旬，請準時繳納避免逾期。', dirty);
    expect((await cardOf(id2))!.receipt_card).toBeNull(); // 容錯：壞輸出不存、不炸收信
  });

  it('非收據信：不燒 AI、不存卡', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    let aiCalls = 0;
    const spy = ({ ...env, AI: { run: async () => { aiCalls += 1; return { response: '{}' }; } } }) as unknown as typeof env;
    const id = await deliverAndIngest(hon.userId, '週末爬山', '週末去爬山，行程如附件，集合時間到週五前再另行通知大家。', spy);
    expect((await cardOf(id))!.receipt_card).toBeNull();
    expect(aiCalls).toBe(0);
  });
});
