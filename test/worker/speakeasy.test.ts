// F9.5：Speakeasy 守門暗號——主旨含暗號的陌生 partial 來信繞過待審；無暗號照常進待審。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { generateSpeakeasy } from '../../src/app/lib/speakeasy';
import { mockEmailMessage, seedUser } from './helpers/fixtures';

// partial verdict（已評估但 SPF/DKIM 不一致）＝會被守門的陌生信；主旨可帶暗號。
function partialEmail(to: string, from: string, subject: string): string {
  const dom = from.split('@')[1];
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Authentication-Results: mx.miseroda.com; spf=pass smtp.mailfrom=${dom}; dkim=fail`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    '哈囉。',
  ].join('\r\n');
}

// INGEST_QUEUE noop：真 env 的 send 會讓佇列在背景自動投遞，consumer 跑在 it() 之外
// （storage frame 已回滾 → no such table: messages / Failed to pop isolated storage）。ingest 由下方手動 batch 跑（L5／L14）。
const deliverEnv = { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;

async function deliverAndIngest(userId: string, raw: string, from: string, to: string): Promise<string> {
  const emailCtx = createExecutionContext();
  await worker.email(mockEmailMessage(raw, { from, to }).message, deliverEnv, emailCtx);
  await waitOnExecutionContext(emailCtx);
  const row = await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(userId)
    .first<{ id: string }>();
  const id = row!.id;
  const batch = createMessageBatch('miseroda-ingest', [
    { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'ingest', messageId: id, userId }, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  await getQueueResult(batch, ctx);
  return id;
}

const screeningOf = (id: string) =>
  env.DB.prepare(`SELECT screening FROM messages WHERE id = ?`).bind(id).first<{ screening: number }>();

describe('F9.5 Speakeasy 守門暗號', () => {
  it('主旨含暗號（不分大小寫）→ 繞過待審直接進收件匣', async () => {
    const u = await seedUser(env, 'hon@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"speakeasy":"Frost-Otter-7"}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const id = await deliverAndIngest(u.userId, partialEmail('hon@miseroda.com', 'stranger@ex.com', '聚餐（frost-otter-7）'), 'stranger@ex.com', 'hon@miseroda.com');
    expect((await screeningOf(id))!.screening).toBe(0);
  });

  it('無暗號 / 主旨不含暗號 → 照常進待審（守門不鬆動）', async () => {
    const u = await seedUser(env, 'hon@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"speakeasy":"frost-otter-7"}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const a = await deliverAndIngest(u.userId, partialEmail('hon@miseroda.com', 's1@ex.com', '一般主旨'), 's1@ex.com', 'hon@miseroda.com');
    expect((await screeningOf(a))!.screening).toBe(1);
  });

  it('未設定暗號的使用者：守門行為完全不變', async () => {
    const u = await seedUser(env, 'hon@miseroda.com');
    const a = await deliverAndIngest(u.userId, partialEmail('hon@miseroda.com', 's2@ex.com', '含 frost-otter-7 也沒用'), 's2@ex.com', 'hon@miseroda.com');
    expect((await screeningOf(a))!.screening).toBe(1);
  });

  it('產生的暗號一樣能放行（新格式與守門閘相容）', async () => {
    const u = await seedUser(env, 'hon@miseroda.com');
    const code = generateSpeakeasy();
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', json_object('speakeasy', ?), ?)`,
    ).bind(u.userId, code, Date.now()).run();
    const id = await deliverAndIngest(u.userId, partialEmail('hon@miseroda.com', 's3@ex.com', `聚餐（${code.toUpperCase()}）`), 's3@ex.com', 'hon@miseroda.com');
    expect((await screeningOf(id))!.screening).toBe(0);
  });
});

// F13：暗號是「陌生人繞過待審」的共享秘密，產生器必須是高熵的（舊版 10 字詞表只有 ~13 bit）。
describe('F13 守門暗號產生器熵', () => {
  it('格式：3 組 × 4 字元、只用去混淆字母表，長度落在 API 的 4–32 字內', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateSpeakeasy();
      expect(code).toMatch(/^[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}$/);
      expect(code.length).toBeGreaterThanOrEqual(4); // ingestConsumer 守門下限
      expect(code.length).toBeLessThanOrEqual(32); // PATCH /settings 上限
    }
  });

  it('空間夠大：500 組全不重複，且 31 個字元全都出現過（排除塌縮成小詞表）', () => {
    const codes = Array.from({ length: 500 }, () => generateSpeakeasy());
    expect(new Set(codes).size).toBe(codes.length);
    const used = new Set(codes.join('').replace(/-/g, ''));
    expect(used.size).toBe(31); // 12 × log2(31) ≈ 59.5 bit
  });
});
