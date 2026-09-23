// AI 摘要路由：mock AI binding、D1 快取、權限
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function aiEnv() {
  let runs = 0;
  const stub = {
    run: async () => {
      runs += 1;
      return {
        response: JSON.stringify({
          summary: '佳螢邀你七月去小琉球潛水，週末前要回覆。',
          category: '朋友',
          replies: ['好啊我要去！', '我查一下時間', '這次先不去 🙏'],
        }),
      };
    },
  };
  return {
    counts: () => runs,
    envAi: { ...env, AI: stub, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env,
  };
}

async function apiCall(
  path: string,
  cookies: { session: string; csrf: string },
  targetEnv: typeof env,
  opts: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
    'X-CSRF-Token': cookies.csrf,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    targetEnv,
    createExecutionContext(),
  );
}

describe('AI summarize', () => {
  it('generates once, caches in D1, enforces ownership', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const { counts, envAi } = aiEnv();

    await worker.email(
      mockEmailMessage(plainEmail({ subject: '潛水邀約', body: '七月第二週小琉球！' })).message,
      envAi,
      createExecutionContext(),
    );
    const msg = await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(hon.userId)
      .first<{ id: string }>();

    const first = await apiCall(`/messages/${msg!.id}/ai`, hon.cookies, envAi, { method: 'POST', body: {} });
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ ai: { summary: string; category: string; replies: string[] }; cached: boolean }>();
    expect(firstBody.cached).toBe(false);
    expect(firstBody.ai.category).toBe('朋友');
    expect(firstBody.ai.replies).toHaveLength(3);
    expect(counts()).toBe(1);

    // 第二次走 D1 快取，不再打 AI
    const second = await apiCall(`/messages/${msg!.id}/ai`, hon.cookies, envAi, { method: 'POST', body: {} });
    const secondBody = await second.json<{ cached: boolean }>();
    expect(secondBody.cached).toBe(true);
    expect(counts()).toBe(1);

    // thread API 帶回 aiSummary
    const detail = await apiCall(`/messages/${msg!.id}`, hon.cookies, envAi);
    const detailBody = await detail.json<{ thread: { aiSummary: { category: string } | null }[] }>();
    expect(detailBody.thread[0].aiSummary?.category).toBe('朋友');

    // 跨使用者 404
    const cross = await apiCall(`/messages/${msg!.id}/ai`, kai.cookies, envAi, { method: 'POST', body: {} });
    expect(cross.status).toBe(404);
  });
});
