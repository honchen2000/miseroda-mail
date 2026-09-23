// 金絲雀：測試環境的預設 env.AI 必須是 test/vitest.base.ts 的封鎖 stub，永遠連不到 Cloudflare 帳號（LESSONS L5）。
// 這支紅了 = 封鎖失效（例如 vpw/miniflare 升級改了 wrappedBindings 合併語意），全套測試又會開始真打 Workers AI。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { AI_MODEL } from '../../src/worker/api/ai';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';
const BLOCKED = 'real Workers AI is blocked in tests';
// 只擋 queue 自動投遞；AI 刻意不覆蓋，走的就是預設 binding
const quietEnv = { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;

describe('測試環境封鎖真 Workers AI', () => {
  it('cloudflare:test 的 env.AI.run 直接 throw 封鎖錯誤', async () => {
    await expect(env.AI.run(AI_MODEL as never, { prompt: 'ping' } as never)).rejects.toThrow(BLOCKED);
  });

  it('worker 路由拿預設 env 呼叫 AI → 走既有失敗降級（502 ai_failed），detail 指出是測試封鎖', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    await worker.email(
      mockEmailMessage(plainEmail({ subject: 'hi', body: 'please translate this english body' })).message,
      quietEnv,
      createExecutionContext(),
    );
    const msg = (await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(hon.userId)
      .first<{ id: string }>())!.id;

    const res = await worker.fetch(
      new Request(`${BASE}/messages/${msg}/translate`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-session=${encodeURIComponent(hon.cookies.session)}; __Host-csrf=${encodeURIComponent(hon.cookies.csrf)}`,
          'X-CSRF-Token': hon.cookies.csrf,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      quietEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(502);
    const body = await res.json<{ error: string; reason: string; detail: string }>();
    expect(body).toMatchObject({ error: 'ai_failed', reason: 'error' });
    expect(body.detail).toContain(BLOCKED);
  });
});
