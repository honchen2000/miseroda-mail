// 乾淨網域別名：ingest 路由（別名→擁有者，含 +tag）+ 寄送驗證（擁有別名可當寄件身分）+ admin CRUD 防呆。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';
function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} }, SEND_QUEUE: { send: async () => {} } } as unknown as typeof env;
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

async function assignAlias(userId: string, address: string) {
  await env.DB.prepare(`INSERT INTO aliases (id, user_id, address, created_by, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(`al_${address}`, userId, address, userId, Date.now())
    .run();
}

describe('alias ingest routing', () => {
  it('寄到別名（含 +tag）→ 投遞給擁有者；未知別名 → 拒收', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    await assignAlias(hon.userId, 'sales@miseroda.com');

    await worker.email(
      mockEmailMessage(plainEmail({ to: 'sales@miseroda.com' }), { to: 'sales@miseroda.com' }).message,
      qenv,
      createExecutionContext(),
    );
    await worker.email(
      mockEmailMessage(plainEmail({ to: 'sales+q3@miseroda.com' }), { to: 'sales+q3@miseroda.com' }).message,
      qenv,
      createExecutionContext(),
    );
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND direction = 'inbound'`)
      .bind(hon.userId)
      .first<{ n: number }>();
    expect(n?.n).toBe(2);

    // 未指派的別名 → 不屬於任何人 → 拒收（無 FORWARD_TO 時）
    const msg = mockEmailMessage(plainEmail({ to: 'nobody@miseroda.com' }), { to: 'nobody@miseroda.com' });
    let rejected = '';
    msg.message.setReject = (r: string) => void (rejected = r);
    await worker.email(msg.message, qenv, createExecutionContext());
    expect(rejected).toBeTruthy();
  });
});

describe('alias as recipient (internal delivery)', () => {
  it('寄到別名 → 內部直送給擁有者，不外送', async () => {
    const calls: unknown[] = [];
    const envS = {
      ...env,
      SEND_EMAIL: {
        send: async (o: unknown) => {
          calls.push(o);
          return { messageId: '<x@cf>' };
        },
      },
      SEND_QUEUE: { send: async () => {} },
      INGEST_QUEUE: { send: async () => {} },
    } as unknown as typeof env;
    const owner = await seedUser(env, 'owner@miseroda.com', 'admin');
    const sender = await seedUser(env, 'sender@miseroda.com');
    await assignAlias(owner.userId, 'sales@miseroda.com');

    const res = await apiCall('/messages/send', sender.cookies, envS, {
      body: { to: ['sales@miseroda.com'], subject: '問候', text: 'hi', undoWindowSec: 0 },
    });
    expect(res.status).toBe(200); // 別名是合法域內收件人（修復前會 400 unknown_internal_recipient）
    const { id } = await res.json<{ id: string }>();

    const batch = createMessageBatch('miseroda-send', [
      { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'send', sendQueueId: id }, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, envS, ctx);
    await getQueueResult(batch, ctx);

    // 擁有者收到內送，且「沒有」走外送（修復前會被當外部地址外送）
    const ownerInbox = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND direction = 'inbound'`,
    )
      .bind(owner.userId)
      .first<{ n: number }>();
    expect(ownerInbox?.n).toBe(1);
    expect(calls.length).toBe(0);
  });
});

describe('alias as calendar attendee', () => {
  it('邀請與會者為別名 → 200、站內直送擁有者、不外送、擁有者行事曆已補寫', async () => {
    const calls: unknown[] = [];
    const envS = {
      ...env,
      SEND_EMAIL: {
        send: async (o: unknown) => {
          calls.push(o);
          return { messageId: '<x@cf>' };
        },
      },
      SEND_QUEUE: { send: async () => {} },
      INGEST_QUEUE: { send: async () => {} },
    } as unknown as typeof env;
    const owner = await seedUser(env, 'owner@miseroda.com', 'admin');
    const organizer = await seedUser(env, 'organizer@miseroda.com');
    await assignAlias(owner.userId, 'sales@miseroda.com');

    const now = Date.now();
    const res = await apiCall('/calendar/invite', organizer.cookies, envS, {
      body: { summary: '專案會議', attendees: ['sales@miseroda.com'], startMs: now + 86400000, endMs: now + 90000000 },
    });
    expect(res.status).toBe(200); // 修復前：400 unknown_internal_recipient

    const sq = (await env.DB.prepare(`SELECT id FROM send_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(organizer.userId)
      .first<{ id: string }>())!;
    const batch = createMessageBatch('miseroda-send', [
      { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'send', sendQueueId: sq.id }, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, envS, ctx);
    await getQueueResult(batch, ctx);

    // 擁有者收到內送邀請、無外送
    const ownerInbox = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND direction = 'inbound'`)
      .bind(owner.userId)
      .first<{ n: number }>();
    expect(ownerInbox?.n).toBe(1);
    expect(calls.length).toBe(0);
    // 擁有者行事曆已補寫（站內直送不解析 .ics，靠 invite 端補寫）
    const cal = await env.DB.prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?`)
      .bind(owner.userId)
      .first<{ n: number }>();
    expect(cal?.n).toBe(1);
  });
});

describe('alias send identity validation', () => {
  it('擁有的別名可當寄件身分；未擁有的同網域地址 → 400', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    await assignAlias(hon.userId, 'sales@miseroda.com');

    const ok = await apiCall('/messages/send', hon.cookies, qenv, {
      body: { to: ['out@external.com'], subject: 's', text: 't', fromAlias: 'sales@miseroda.com', undoWindowSec: 0 },
    });
    expect(ok.status).toBe(200);

    const bad = await apiCall('/messages/send', hon.cookies, qenv, {
      body: { to: ['out@external.com'], subject: 's', text: 't', fromAlias: 'other@miseroda.com', undoWindowSec: 0 },
    });
    expect(bad.status).toBe(400);
  });
});

describe('admin alias CRUD', () => {
  it('指派 / 列出 / 刪除 + 防呆（撞 email、保留字、重複、非網域）+ 非 admin 403', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');

    expect((await apiCall('/admin/aliases', hon.cookies, env, { body: { userId: hon.userId, address: 'sales@miseroda.com' } })).status).toBe(200);
    // 撞使用者 email
    expect((await apiCall('/admin/aliases', hon.cookies, env, { body: { userId: hon.userId, address: 'hon@miseroda.com' } })).status).toBe(400);
    // 保留字
    expect((await apiCall('/admin/aliases', hon.cookies, env, { body: { userId: hon.userId, address: 'postmaster@miseroda.com' } })).status).toBe(400);
    // 重複
    expect((await apiCall('/admin/aliases', hon.cookies, env, { body: { userId: hon.userId, address: 'sales@miseroda.com' } })).status).toBe(400);
    // 非本網域
    expect((await apiCall('/admin/aliases', hon.cookies, env, { body: { userId: hon.userId, address: 'sales@evil.com' } })).status).toBe(400);
    // 非 admin 不能用
    expect((await apiCall('/admin/aliases', kai.cookies, env, { body: { userId: kai.userId, address: 'x@miseroda.com' } })).status).toBe(403);

    // 列出 + 刪除
    const list = await (await apiCall('/admin/aliases', hon.cookies, env)).json<{ aliases: { id: string; address: string }[] }>();
    expect(list.aliases.map((a) => a.address)).toContain('sales@miseroda.com');
    const id = list.aliases.find((a) => a.address === 'sales@miseroda.com')!.id;
    expect((await apiCall(`/admin/aliases/${id}`, hon.cookies, env, { method: 'DELETE' })).status).toBe(200);
    const after = await (await apiCall('/admin/aliases', hon.cookies, env)).json<{ aliases: unknown[] }>();
    expect(after.aliases.length).toBe(0);
  });
});
