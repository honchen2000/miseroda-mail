// 跟進提醒：設定 / 列表 / cron 觸發 / 等回覆自動消除 / 完成 / 跨使用者隔離
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function quietEnv(extra: Record<string, unknown> = {}) {
  return { ...env, INGEST_QUEUE: { send: async () => {} }, ...extra } as unknown as typeof env;
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

async function deliver(targetEnv: typeof env, email: string, subject: string) {
  await worker.email(mockEmailMessage(plainEmail({ to: email, subject, body: `${subject} body` }), { to: email }).message, targetEnv, createExecutionContext());
  return (await env.DB.prepare(`SELECT id, thread_id FROM messages WHERE user_id = (SELECT id FROM users WHERE email=?) ORDER BY created_at DESC LIMIT 1`)
    .bind(email)
    .first<{ id: string; thread_id: string }>())!;
}

interface FollowUpDto { id: string; messageId: string; subject: string; dueAt: number; awaitReply: boolean; status: string }

describe('follow-ups', () => {
  it('set → list → done', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const m = await deliver(qenv, 'hon@miseroda.com', '稍後跟進這封');

    const due = Date.now() + 3600_000;
    const set = await apiCall(`/messages/${m.id}/followup`, hon.cookies, qenv, { body: { dueAt: due, awaitReply: false } });
    expect(set.status).toBe(200);

    const list = await (await apiCall('/followups', hon.cookies, qenv)).json<{ followups: FollowUpDto[] }>();
    const f = list.followups.find((x) => x.messageId === m.id);
    expect(f).toBeTruthy();
    expect(f!.status).toBe('pending');
    expect(f!.subject).toBe('稍後跟進這封');

    // counts.followups
    const counts = await (await apiCall('/mailbox/counts', hon.cookies, qenv)).json<{ followups: number }>();
    expect(counts.followups).toBeGreaterThanOrEqual(1);

    // 標記完成 → 移出清單
    const done = await apiCall(`/followups/${f!.id}/done`, hon.cookies, qenv, { body: {} });
    expect(done.status).toBe(200);
    const list2 = await (await apiCall('/followups', hon.cookies, qenv)).json<{ followups: FollowUpDto[] }>();
    expect(list2.followups.find((x) => x.messageId === m.id)).toBeUndefined();
  });

  it('upsert overwrites existing follow-up for same message', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const m = await deliver(qenv, 'hon@miseroda.com', '重設跟進');

    await apiCall(`/messages/${m.id}/followup`, hon.cookies, qenv, { body: { dueAt: Date.now() + 3600_000, awaitReply: false } });
    const due2 = Date.now() + 7200_000;
    await apiCall(`/messages/${m.id}/followup`, hon.cookies, qenv, { body: { dueAt: due2, awaitReply: true } });

    const list = await (await apiCall('/followups', hon.cookies, qenv)).json<{ followups: FollowUpDto[] }>();
    const f = list.followups.filter((x) => x.messageId === m.id);
    expect(f.length).toBe(1); // 不重複，UNIQUE(user_id, message_id)
    expect(f[0].dueAt).toBe(due2);
    expect(f[0].awaitReply).toBe(true);
  });

  it('cron fires a due pending follow-up → status fired', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const m = await deliver(qenv, 'hon@miseroda.com', '到期提醒');
    await apiCall(`/messages/${m.id}/followup`, hon.cookies, qenv, { body: { dueAt: Date.now() + 3600_000, awaitReply: false } });

    // 強制到期
    await env.DB.prepare(`UPDATE follow_ups SET due_at = ? WHERE message_id = ? AND user_id = ?`)
      .bind(Date.now() - 1000, m.id, hon.userId)
      .run();
    const { sweep } = await import('../../src/worker/jobs/sweep');
    await sweep(qenv);
    // 第二次 sweep 不應重新觸發（CAS 認領 + status 已非 pending）
    await sweep(qenv);

    const row = await env.DB.prepare(`SELECT status FROM follow_ups WHERE message_id = ? AND user_id = ?`)
      .bind(m.id, hon.userId)
      .first<{ status: string }>();
    expect(row!.status).toBe('fired');
    // 仍出現在清單（pending + fired）
    const list = await (await apiCall('/followups', hon.cookies, qenv)).json<{ followups: FollowUpDto[] }>();
    expect(list.followups.find((x) => x.messageId === m.id)?.status).toBe('fired');
  });

  it('await-reply: a newer inbound reply clears the follow-up instead of firing', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const m = await deliver(qenv, 'hon@miseroda.com', '等回覆');
    await apiCall(`/messages/${m.id}/followup`, hon.cookies, qenv, { body: { dueAt: Date.now() + 3600_000, awaitReply: true } });

    // 同對話串、晚於 ref_at 的新進信
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, to_addrs, subject, snippet, folder, received_at, created_at)
       VALUES (?, ?, ?, 'inbound', 'them@ext.com', '[]', 'Re: 等回覆', '', 'inbox', ?, ?)`,
    )
      .bind('msg_reply_1', hon.userId, m.thread_id, Date.now() + 5000, Date.now() + 5000)
      .run();

    await env.DB.prepare(`UPDATE follow_ups SET due_at = ? WHERE message_id = ? AND user_id = ?`)
      .bind(Date.now() - 1000, m.id, hon.userId)
      .run();
    const { sweep } = await import('../../src/worker/jobs/sweep');
    await sweep(qenv);

    const row = await env.DB.prepare(`SELECT status FROM follow_ups WHERE message_id = ? AND user_id = ?`)
      .bind(m.id, hon.userId)
      .first<{ status: string }>();
    expect(row!.status).toBe('done'); // 已收到回覆，自動消除、不提醒
  });

  it('rejects bad time and cross-user message', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const km = await deliver(qenv, 'kai@miseroda.com', 'kai 的信');

    // 太遠的時間
    const tooFar = await apiCall(`/messages/${km.id}/followup`, kai.cookies, qenv, {
      body: { dueAt: Date.now() + 5 * 365 * 86400_000, awaitReply: false },
    });
    expect(tooFar.status).toBe(400);

    // hon 不能對 kai 的信設跟進
    const cross = await apiCall(`/messages/${km.id}/followup`, hon.cookies, qenv, { body: { dueAt: Date.now() + 3600_000, awaitReply: false } });
    expect(cross.status).toBe(404);
  });
});
