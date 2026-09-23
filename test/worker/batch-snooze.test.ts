// 批次操作 + Snooze + AI 翻譯
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createScheduledController, env } from 'cloudflare:test';
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

async function deliver(targetEnv: typeof env, subject: string) {
  await worker.email(mockEmailMessage(plainEmail({ subject, body: `${subject} body` })).message, targetEnv, createExecutionContext());
  return (await env.DB.prepare(`SELECT id FROM messages WHERE user_id = (SELECT id FROM users WHERE email='hon@miseroda.com') ORDER BY created_at DESC LIMIT 1`).first<{ id: string }>())!.id;
}

describe('batch / snooze / translate', () => {
  it('batch actions, label scoping, isolation', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const a = await deliver(qenv, '批次一');
    const b = await deliver(qenv, '批次二');

    const labelId = 'lbl_b1';
    await env.DB.prepare(`INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, '工作', '#38BDF8', ?)`)
      .bind(labelId, hon.userId, Date.now())
      .run();

    // 批次封存 + 加標籤
    const res = await apiCall('/messages/batch', hon.cookies, qenv, {
      body: { ids: [a, b], patch: { folder: 'archive' }, addLabelId: labelId },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ count: number }>()).count).toBe(2);
    for (const id of [a, b]) {
      const row = await env.DB.prepare(`SELECT folder FROM messages WHERE id = ?`).bind(id).first<{ folder: string }>();
      expect(row!.folder).toBe('archive');
      const lbl = await env.DB.prepare(`SELECT COUNT(*) AS n FROM message_labels WHERE message_id = ? AND label_id = ?`)
        .bind(id, labelId)
        .first<{ n: number }>();
      expect(lbl!.n).toBe(1);
    }

    // 別人的 id 混進來不影響（user_id scope）
    const kaiMsgId = 'msg_kai_x';
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, to_addrs, subject, snippet, folder, received_at, created_at)
       VALUES (?, ?, 'thr_k', 'inbound', 'x@y.com', '[]', 'kai', '', 'inbox', ?, ?)`,
    )
      .bind(kaiMsgId, kai.userId, Date.now(), Date.now())
      .run();
    await apiCall('/messages/batch', hon.cookies, qenv, { body: { ids: [kaiMsgId], patch: { folder: 'trash' } } });
    const kaiRow = await env.DB.prepare(`SELECT folder FROM messages WHERE id = ?`).bind(kaiMsgId).first<{ folder: string }>();
    expect(kaiRow!.folder).toBe('inbox'); // 未被動到
  });

  it('snooze hides from inbox, shows in snoozed, sweep restores', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const m = await deliver(qenv, '貪睡測試');

    const until = Date.now() + 3600_000;
    const snoozeRes = await apiCall(`/messages/${m}`, hon.cookies, qenv, { method: 'PATCH', body: { snoozedUntil: until } });
    expect(snoozeRes.status).toBe(200);

    // 收件匣看不到
    const inbox = await (await apiCall('/messages?folder=inbox', hon.cookies, qenv)).json<{ items: { id: string }[] }>();
    expect(inbox.items.map((i) => i.id)).not.toContain(m);
    // snoozed 視圖看得到
    const snoozedList = await (await apiCall('/messages?folder=snoozed', hon.cookies, qenv)).json<{ items: { id: string }[] }>();
    expect(snoozedList.items.map((i) => i.id)).toContain(m);
    // counts.snoozed
    const counts = await (await apiCall('/mailbox/counts', hon.cookies, qenv)).json<{ snoozed: number; folders: Record<string, { total: number }> }>();
    expect(counts.snoozed).toBeGreaterThanOrEqual(1);

    // sweep 之前先把時間改成已到期
    await env.DB.prepare(`UPDATE messages SET snoozed_until = ? WHERE id = ?`).bind(Date.now() - 1000, m).run();
    const { sweep } = await import('../../src/worker/jobs/sweep');
    await sweep(qenv);
    const restored = await env.DB.prepare(`SELECT snoozed_until, is_read FROM messages WHERE id = ?`)
      .bind(m)
      .first<{ snoozed_until: number | null; is_read: number }>();
    expect(restored!.snoozed_until).toBeNull();
    expect(restored!.is_read).toBe(0);
    // 回到收件匣
    const inbox2 = await (await apiCall('/messages?folder=inbox', hon.cookies, qenv)).json<{ items: { id: string }[] }>();
    expect(inbox2.items.map((i) => i.id)).toContain(m);
  });

  it('scheduled handler runs sweep without throwing', async () => {
    const qenv = quietEnv();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: '* * * * *' }), qenv, ctx);
  });

  it('F13.2：snooze 喚醒發 snooze-wake 通知；重跑 sweep 不重複（CAS 認領）', async () => {
    // 攔 USER_HUB 的 WS notify 收集 type（不動真 DO）
    const wsTypes: string[] = [];
    const qenv = quietEnv({
      USER_HUB: {
        idFromName: () => 'stub',
        get: () => ({
          fetch: async (_url: string, init?: RequestInit) => {
            wsTypes.push((JSON.parse(init?.body as string) as { type: string }).type);
            return new Response('{}');
          },
        }),
      },
    });
    await seedUser(env, 'hon@miseroda.com', 'admin');
    const m = await deliver(qenv, '喚醒推播測試');
    await env.DB.prepare(`UPDATE messages SET snoozed_until = ? WHERE id = ?`).bind(Date.now() - 1000, m).run();

    const { sweep } = await import('../../src/worker/jobs/sweep');
    await sweep(qenv);
    expect(wsTypes.filter((t) => t === 'snooze-wake')).toHaveLength(1);
    const woken = await env.DB.prepare(`SELECT snoozed_until, is_read FROM messages WHERE id = ?`)
      .bind(m)
      .first<{ snoozed_until: number | null; is_read: number }>();
    expect(woken!.snoozed_until).toBeNull();
    expect(woken!.is_read).toBe(0);
    // 冪等：第二輪 sweep 沒有可認領列，不再通知
    await sweep(qenv);
    expect(wsTypes.filter((t) => t === 'snooze-wake')).toHaveLength(1);
  });

  it('translate generates once, caches, isolates', async () => {
    let runs = 0;
    const aiStub = { run: async () => { runs += 1; return { response: '這是翻譯後的繁體中文內容。' }; } };
    const qenv = quietEnv({ AI: aiStub });
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const m = await deliver(qenv, 'Translate me');
    // 需要 r2_html_key（ingest consumer 產生）；直接塞一個簡單 html
    await env.MAIL_STORE.put(`html/${hon.userId}/${m}.html`, '<p>Hello world, please translate this.</p>');
    await env.DB.prepare(`UPDATE messages SET r2_html_key = ? WHERE id = ?`).bind(`html/${hon.userId}/${m}.html`, m).run();

    const first = await apiCall(`/messages/${m}/translate`, hon.cookies, qenv, { method: 'POST', body: {} });
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ translation: string; cached: boolean }>();
    expect(firstBody.cached).toBe(false);
    expect(firstBody.translation).toContain('繁體中文');
    expect(runs).toBe(1);

    const second = await apiCall(`/messages/${m}/translate`, hon.cookies, qenv, { method: 'POST', body: {} });
    expect((await second.json<{ cached: boolean }>()).cached).toBe(true);
    expect(runs).toBe(1);

    const cross = await apiCall(`/messages/${m}/translate`, kai.cookies, qenv, { method: 'POST', body: {} });
    expect(cross.status).toBe(404);
  });
});
