// F10.2：抵達即備稿 —— 窄判定純函式 / ingest 生成寫 KV / 設定關閉 / 端點讀取與越權。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';
import { autoDraftKey, looksNeedsReply } from '../../src/worker/lib/autoDraft';

const BASE = 'https://mail.miseroda.com/api/v1';

async function apiCall(path: string, cookies: { session: string; csrf: string }) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: { Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}` },
    }),
    env,
    createExecutionContext(),
  );
}

async function deliverAndIngest(userId: string, subject: string, body: string, aiEnv: typeof env): Promise<string> {
  // INGEST_QUEUE noop：擋掉自動投遞（否則真 env 會先跑 consumer 寫 processedKey，手動 mock batch 變 no-op）
  const deliverEnv = { ...aiEnv, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
  await worker.email(
    mockEmailMessage(plainEmail({ subject, body, to: 'hon@miseroda.com' }), { from: 'friend@example.com', to: 'hon@miseroda.com' }).message,
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

const mockAiEnv = (draft: string) =>
  ({ ...env, AI: { run: async () => ({ response: draft }) } }) as unknown as typeof env;

describe('F10.2 抵達即備稿', () => {
  it('looksNeedsReply 窄判定：問句私人信 ✓；批量/noreply/太短/無問句 ✗', () => {
    const base = { direction: 'inbound', listUnsubscribe: null, fromAddr: 'a@x.com', subject: 'hi', body: '請問你這週五方便一起吃飯嗎？想跟你聊聊。' };
    expect(looksNeedsReply(base)).toBe(true);
    expect(looksNeedsReply({ ...base, listUnsubscribe: '<mailto:u@x.com>' })).toBe(false);
    expect(looksNeedsReply({ ...base, fromAddr: 'no-reply@shop.com' })).toBe(false);
    expect(looksNeedsReply({ ...base, body: '好？' })).toBe(false); // 太短
    expect(looksNeedsReply({ ...base, subject: '收據', body: '感謝您的購買，本封為系統通知，附上明細供您留存參考。' })).toBe(false); // 無問句/請求
    expect(looksNeedsReply({ ...base, direction: 'outbound' })).toBe(false);
  });

  it('ingest：問句私人信 → KV 備稿；端點讀得到；越權 404', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const id = await deliverAndIngest(hon.userId, '週五聚餐', '請問你這週五方便一起吃飯嗎？地點你挑，我都可以配合。', mockAiEnv('好啊，週五可以！地點就選〔待補〕如何？'));
    const kv = await env.KV.get(autoDraftKey(hon.userId, id), 'json');
    expect((kv as { draft: string }).draft).toContain('週五');

    const r = await apiCall(`/messages/${id}/auto-draft`, hon.cookies);
    expect(((await r.json()) as { draft: string }).draft).toContain('好啊');
    expect((await apiCall(`/messages/${id}/auto-draft`, kai.cookies)).status).toBe(404);
  });

  it('設定 autoDrafts=false → 不生成；通知型信（無問句）也不生成', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"autoDrafts":false}', ?)`,
    ).bind(hon.userId, Date.now()).run();
    let aiCalls = 0;
    const spyEnv = { ...env, AI: { run: async () => { aiCalls += 1; return { response: 'x' }; } } } as unknown as typeof env;
    const id = await deliverAndIngest(hon.userId, '聚餐', '請問你這週五方便一起吃飯嗎？想約你很久了。', spyEnv);
    expect(await env.KV.get(autoDraftKey(hon.userId, id))).toBeNull();
    expect(aiCalls).toBe(0);
  });
});
