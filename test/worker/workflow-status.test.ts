// 工作流狀態：PATCH status/pinned → 虛擬資料夾（needs_reply/waiting/pinned）+ 側欄計數。
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
    quietEnv(),
    createExecutionContext(),
  );
}
async function ids(path: string, cookies: { session: string; csrf: string }) {
  const r = await (await apiCall(path, cookies)).json<{ items: { id: string }[] }>();
  return r.items.map((i) => i.id);
}
async function counts(cookies: { session: string; csrf: string }) {
  return (await apiCall('/mailbox/counts', cookies)).json<{ needsReply: number; waiting: number; pinned: number }>();
}

describe('workflow status (needs_reply / waiting / pinned)', () => {
  it('PATCH status/pinned 驅動虛擬資料夾與側欄計數', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    await worker.email(mockEmailMessage(plainEmail({ subject: 'A' })).message, quietEnv(), createExecutionContext());
    await worker.email(mockEmailMessage(plainEmail({ subject: 'B' })).message, quietEnv(), createExecutionContext());
    const msg = (await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(hon.userId)
      .first<{ id: string }>())!.id;

    // 標記需回信 → 出現在 needs_reply、計數 1
    expect((await apiCall(`/messages/${msg}`, hon.cookies, { method: 'PATCH', body: { status: 'needs_reply' } })).status).toBe(200);
    expect(await ids('/messages?folder=needs_reply', hon.cookies)).toEqual([msg]);
    expect((await counts(hon.cookies)).needsReply).toBe(1);

    // 改成等待中 → 離開 needs_reply、進 waiting
    await apiCall(`/messages/${msg}`, hon.cookies, { method: 'PATCH', body: { status: 'waiting' } });
    expect(await ids('/messages?folder=needs_reply', hon.cookies)).toEqual([]);
    expect(await ids('/messages?folder=waiting', hon.cookies)).toEqual([msg]);
    expect((await counts(hon.cookies)).waiting).toBe(1);

    // 釘選（與 status 正交）→ 進 pinned，仍在 waiting
    await apiCall(`/messages/${msg}`, hon.cookies, { method: 'PATCH', body: { pinned: true } });
    expect(await ids('/messages?folder=pinned', hon.cookies)).toEqual([msg]);
    expect(await ids('/messages?folder=waiting', hon.cookies)).toEqual([msg]);
    const c1 = await counts(hon.cookies);
    expect(c1.pinned).toBe(1);
    expect(c1.waiting).toBe(1);

    // 清除 status（null）→ 離開 waiting，pinned 不受影響
    await apiCall(`/messages/${msg}`, hon.cookies, { method: 'PATCH', body: { status: null } });
    expect(await ids('/messages?folder=waiting', hon.cookies)).toEqual([]);
    expect(await ids('/messages?folder=pinned', hon.cookies)).toEqual([msg]);
    const c2 = await counts(hon.cookies);
    expect(c2.waiting).toBe(0);
    expect(c2.pinned).toBe(1);

    // 取消釘選
    await apiCall(`/messages/${msg}`, hon.cookies, { method: 'PATCH', body: { pinned: false } });
    expect(await ids('/messages?folder=pinned', hon.cookies)).toEqual([]);
    expect((await counts(hon.cookies)).pinned).toBe(0);

    // 非法 status 值被擋
    expect((await apiCall(`/messages/${msg}`, hon.cookies, { method: 'PATCH', body: { status: 'nonsense' } })).status).toBe(400);
  });
});
