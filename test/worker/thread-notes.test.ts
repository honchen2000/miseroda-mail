// F9.7：線程便利貼 + 顯示主旨改寫 —— CRUD / 隔離 / override 不影響原主旨搜尋與資料。
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

async function seedMsg(userId: string, id: string, threadId: string, subject = '季度報表') {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO threads (id, user_id, subject, last_message_at, message_count) VALUES (?, ?, ?, ?, 1)`)
    .bind(threadId, userId, subject, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, subject, snippet, folder, is_read, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', 'a@x.com', ?, '', 'inbox', 1, ?, ?)`,
  )
    .bind(id, userId, threadId, subject, now, now)
    .run();
}

describe('F9.7 線程便利貼 + 改主旨', () => {
  it('便利貼 upsert / 讀回 / 清空刪除；他人 thread 404', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    await seedMsg(hon.userId, 'tn1', 'th-tn1');

    expect((await apiCall('/threads/th-tn1/note', hon.cookies, { method: 'PUT', body: { note: '記得回報稅務' } })).status).toBe(200);
    const th = (await (await apiCall('/messages/tn1', hon.cookies)).json()) as { note: string; noteUpdatedAt: number | null };
    expect(th.note).toBe('記得回報稅務');
    expect(th.noteUpdatedAt).toBeGreaterThan(0);

    // 清空 = 刪除
    await apiCall('/threads/th-tn1/note', hon.cookies, { method: 'PUT', body: { note: '  ' } });
    expect(await env.DB.prepare(`SELECT 1 FROM thread_notes WHERE thread_id = 'th-tn1'`).first()).toBeNull();

    // 他人 thread → 404（不可越權貼便利貼）
    expect((await apiCall('/threads/th-tn1/note', kai.cookies, { method: 'PUT', body: { note: 'x' } })).status).toBe(404);
  });

  it('subjectOverride：PATCH 生效、清空還原；原 subject 欄位不動（搜尋/回覆引用安全）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    await seedMsg(hon.userId, 'tn2', 'th-tn2', '第三季報表 Q3');

    expect((await apiCall('/messages/tn2', hon.cookies, { method: 'PATCH', body: { subjectOverride: '⭐ 重要：報稅資料' } })).status).toBe(200);
    const row = await env.DB.prepare(`SELECT subject, subject_override FROM messages WHERE id = 'tn2'`)
      .first<{ subject: string; subject_override: string | null }>();
    expect(row!.subject).toBe('第三季報表 Q3'); // 原主旨永不動
    expect(row!.subject_override).toBe('⭐ 重要：報稅資料');

    // thread 回應帶 override + 原 subject 並存
    const th = (await (await apiCall('/messages/tn2', hon.cookies)).json()) as { thread: { subject: string; subjectOverride: string | null }[] };
    expect(th.thread[0].subject).toBe('第三季報表 Q3');
    expect(th.thread[0].subjectOverride).toBe('⭐ 重要：報稅資料');

    // 空字串 = 還原
    await apiCall('/messages/tn2', hon.cookies, { method: 'PATCH', body: { subjectOverride: '' } });
    const row2 = await env.DB.prepare(`SELECT subject_override FROM messages WHERE id = 'tn2'`).first<{ subject_override: string | null }>();
    expect(row2!.subject_override).toBeNull();
  });
});
