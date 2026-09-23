// 手動移到其他收件匣分類：PATCH /messages/:id { category } 改分類 + 出現在新分頁、離開舊分頁。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';
function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
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

describe('move message to inbox category', () => {
  it('PATCH category moves the message between category tabs; invalid category rejected', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    await worker.email(mockEmailMessage(plainEmail({ subject: '分類移動' })).message, qenv, createExecutionContext());
    const msg = (await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(hon.userId)
      .first<{ id: string }>())!.id;
    await env.DB.prepare(`UPDATE messages SET category = 'primary' WHERE id = ?`).bind(msg).run();

    // 移到「通知」(updates)
    const res = await apiCall(`/messages/${msg}`, hon.cookies, qenv, { method: 'PATCH', body: { category: 'updates' } });
    expect(res.status).toBe(200);
    expect((await env.DB.prepare(`SELECT category FROM messages WHERE id = ?`).bind(msg).first<{ category: string }>())!.category).toBe('updates');

    // 出現在 updates 分頁、離開 primary 分頁
    const updates = await (await apiCall('/messages?folder=inbox&category=updates', hon.cookies, qenv)).json<{ items: { id: string }[] }>();
    expect(updates.items.map((i) => i.id)).toContain(msg);
    const primary = await (await apiCall('/messages?folder=inbox&category=primary', hon.cookies, qenv)).json<{ items: { id: string }[] }>();
    expect(primary.items.map((i) => i.id)).not.toContain(msg);

    // 非法分類值被擋
    const bad = await apiCall(`/messages/${msg}`, hon.cookies, qenv, { method: 'PATCH', body: { category: 'nonsense' } });
    expect(bad.status).toBe(400);
  });
});
