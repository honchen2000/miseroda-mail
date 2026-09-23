// AI 失敗原因分類：額度/容量錯誤 → reason 'quota'；其他 → 'error'（讓前端顯示貼切訊息）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';
function throwingAiEnv(msg: string) {
  return {
    ...env,
    AI: { run: async () => { throw new Error(msg); } },
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as typeof env;
}
function post(path: string, cookies: { session: string; csrf: string }, targetEnv: typeof env) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
    targetEnv,
    createExecutionContext(),
  );
}

describe('AI failure reason classification', () => {
  it('翻譯：額度錯誤 → reason quota；一般錯誤 → reason error', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const e1 = throwingAiEnv('You have exceeded your daily Neuron quota');
    await worker.email(
      mockEmailMessage(plainEmail({ subject: 'hi', body: 'please translate this english body' })).message,
      e1,
      createExecutionContext(),
    );
    const msg = (await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(hon.userId)
      .first<{ id: string }>())!.id;

    const r1 = await post(`/messages/${msg}/translate`, hon.cookies, e1);
    expect(r1.status).toBe(502);
    expect(await r1.json()).toMatchObject({ error: 'ai_failed', reason: 'quota' });

    // 失敗不快取 → 再打一次（不同錯誤）回 error
    const e2 = throwingAiEnv('some random internal boom');
    const r2 = await post(`/messages/${msg}/translate`, hon.cookies, e2);
    expect(await r2.json()).toMatchObject({ error: 'ai_failed', reason: 'error' });
  });
});
