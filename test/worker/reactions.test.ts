// F11.1：站內 emoji 反應 —— 跨複本共享 / toggle / 隔離（外人不可反應）/ 對外信拒絕。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

async function apiCall(
  path: string,
  cookies: { session: string; csrf: string },
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
    env,
    createExecutionContext(),
  );
}

/** 模擬 deliverInternal 後狀態：寄件者 Sent 複本 + 收件者 inbox 複本，同 message_id_header。 */
async function seedInternalPair(senderId: string, senderEmail: string, recipientId: string) {
  const now = Date.now();
  const header = `<msg-${now}@miseroda.com>`;
  const mk = (id: string, uid: string, folder: string, dir: string) =>
    env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, message_id_header, direction, from_addr, from_name, subject, snippet, folder, is_read, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Hon', '晚餐吃什麼', '', ?, 1, ?, ?)`,
    ).bind(id, uid, `t-${id}`, header, dir, senderEmail, folder, now, now).run();
  await mk('rx-sent', senderId, 'sent', 'outbound');
  await mk('rx-in', recipientId, 'inbox', 'inbound');
  return header;
}

describe('F11.1 站內 emoji 反應', () => {
  it('跨複本：收件者按 👍 → 寄件者在自己的 Sent 複本 thread 看得到；toggle 取消', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    await seedInternalPair(hon.userId, 'hon@miseroda.com', kai.userId);

    // kai（收件者）按 👍
    const r1 = await apiCall('/messages/rx-in/react', kai.cookies, { body: { emoji: '👍' } });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { reacted: boolean }).reacted).toBe(true);

    // hon 打開自己的 Sent 複本 → 看到 kai 的 👍（internal + reactions）
    const th = (await (await apiCall('/messages/rx-sent', hon.cookies)).json()) as {
      thread: { id: string; internal?: boolean; reactions?: { emoji: string; count: number; mine: boolean }[] }[];
    };
    const m = th.thread.find((t) => t.id === 'rx-sent')!;
    expect(m.internal).toBe(true);
    expect(m.reactions).toEqual([{ emoji: '👍', count: 1, mine: false, names: expect.any(Array) }]);

    // toggle 取消 → 消失
    await apiCall('/messages/rx-in/react', kai.cookies, { body: { emoji: '👍' } });
    const th2 = (await (await apiCall('/messages/rx-sent', hon.cookies)).json()) as { thread: { id: string; reactions?: unknown[] }[] };
    expect(th2.thread.find((t) => t.id === 'rx-sent')!.reactions).toEqual([]);
  });

  it('隔離與守門：無複本的外人 404；對外信 400；非法 emoji 400', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const out = await seedUser(env, 'outsider@miseroda.com');
    await seedInternalPair(hon.userId, 'hon@miseroda.com', kai.userId);
    expect((await apiCall('/messages/rx-in/react', out.cookies, { body: { emoji: '👍' } })).status).toBe(404);
    expect((await apiCall('/messages/rx-in/react', kai.cookies, { body: { emoji: '💀' } })).status).toBe(400);

    // 對外信（from 非站內網域）→ 400 not_internal
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, message_id_header, direction, from_addr, subject, snippet, folder, is_read, received_at, created_at)
       VALUES ('rx-ext', ?, 't-ext', '<e@gmail.com>', 'inbound', 'x@gmail.com', 'hi', '', 'inbox', 1, ?, ?)`,
    ).bind(hon.userId, now, now).run();
    const r = await apiCall('/messages/rx-ext/react', hon.cookies, { body: { emoji: '👍' } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe('not_internal');
  });
});
