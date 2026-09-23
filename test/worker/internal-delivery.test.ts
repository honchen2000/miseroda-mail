// 站內直送 + 假期自動回覆 + 內部收件人驗證
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function stubEnv() {
  const sendCalls: Record<string, unknown>[] = [];
  const enqueued: { kind: string; sendQueueId?: string }[] = [];
  const envS = {
    ...env,
    SEND_EMAIL: { send: async (o: Record<string, unknown>) => { sendCalls.push(o); return { messageId: '<x@cf>' }; } },
    SEND_QUEUE: { send: async (b: { kind: string; sendQueueId?: string }) => void enqueued.push(b) },
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as typeof env;
  return { sendCalls, enqueued, envS };
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

async function runSend(sendQueueId: string, targetEnv: typeof env) {
  const batch = createMessageBatch('miseroda-send', [
    { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'send', sendQueueId }, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, targetEnv, ctx);
  await getQueueResult(batch, ctx);
}

describe('internal delivery', () => {
  it('same-domain mail lands directly in recipient inbox (no SMTP), threading both ways', async () => {
    const { sendCalls, envS } = stubEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const tom = await seedUser(env, 'tom@miseroda.com');

    /* ---- hon → tom（全內部：不打 Email Service） ---- */
    const sendRes = await apiCall('/messages/send', hon.cookies, envS, {
      body: { to: ['tom@miseroda.com'], subject: '站內測試', text: '哈囉 Tom！', undoWindowSec: 0 },
    });
    expect(sendRes.status).toBe(200);
    const { id: sq1 } = await sendRes.json<{ id: string }>();
    await runSend(sq1, envS);
    expect(sendCalls).toHaveLength(0); // 零外部寄送

    // tom 收件匣有信
    const tomInbox = await (await apiCall('/messages?folder=inbox', tom.cookies, envS)).json<{
      items: { id: string; subject: string; from: { addr: string }; unread: boolean }[];
    }>();
    expect(tomInbox.items).toHaveLength(1);
    expect(tomInbox.items[0].subject).toBe('站內測試');
    expect(tomInbox.items[0].from.addr).toBe('hon@miseroda.com');
    expect(tomInbox.items[0].unread).toBe(true);

    // hon 寄件備份有信
    const honSent = await (await apiCall('/messages?folder=sent', hon.cookies, envS)).json<{ items: { id: string }[] }>();
    expect(honSent.items).toHaveLength(1);

    /* ---- tom 回覆 hon → 兩邊各自串成對話串 ---- */
    const tomMsgId = tomInbox.items[0].id;
    const replyRes = await apiCall('/messages/send', tom.cookies, envS, {
      body: { to: ['hon@miseroda.com'], subject: 'Re: 站內測試', text: '收到！', replyToMessageId: tomMsgId, undoWindowSec: 0 },
    });
    const { id: sq2 } = await replyRes.json<{ id: string }>();
    await runSend(sq2, envS);

    const honInbox = await (await apiCall('/messages?folder=inbox', hon.cookies, envS)).json<{
      items: { id: string; threadId: string }[];
    }>();
    expect(honInbox.items).toHaveLength(1);
    // hon 的收件（tom 的回覆）與 hon 的寄件備份在同一 thread
    const honSent2 = await (await apiCall('/messages?folder=sent', hon.cookies, envS)).json<{
      items: { id: string; threadId: string }[];
    }>();
    expect(honInbox.items[0].threadId).toBe(honSent2.items[0].threadId);

    /* ---- 自寄：sent + inbox 各一份 ---- */
    const selfRes = await apiCall('/messages/send', hon.cookies, envS, {
      body: { to: ['hon@miseroda.com'], subject: '給自己的備忘', text: '記得買牛奶', undoWindowSec: 0 },
    });
    const { id: sq3 } = await selfRes.json<{ id: string }>();
    await runSend(sq3, envS);
    const honInbox2 = await (await apiCall('/messages?folder=inbox', hon.cookies, envS)).json<{ items: { subject: string }[] }>();
    expect(honInbox2.items.map((i) => i.subject)).toContain('給自己的備忘');
    expect(sendCalls).toHaveLength(0); // 至此仍零外部寄送

    /* ---- 混合收件：內部直送 + 外部走 Email Service ---- */
    const mixRes = await apiCall('/messages/send', hon.cookies, envS, {
      body: { to: ['tom@miseroda.com', 'out@example.com'], subject: '混合', text: 'mix', undoWindowSec: 0 },
    });
    const { id: sq4 } = await mixRes.json<{ id: string }>();
    await runSend(sq4, envS);
    expect(sendCalls).toHaveLength(1);
    expect((sendCalls[0] as { to: string[] }).to).toEqual(['out@example.com']); // 外部副本只含外部地址
    const tomInbox2 = await (await apiCall('/messages?folder=inbox', tom.cookies, envS)).json<{ items: { subject: string }[] }>();
    expect(tomInbox2.items.map((i) => i.subject)).toContain('混合');

    /* ---- 不存在的內部地址：寄出時就擋 ---- */
    const badRes = await apiCall('/messages/send', hon.cookies, envS, {
      body: { to: ['ghost@miseroda.com'], subject: 'x', text: 'x' },
    });
    expect(badRes.status).toBe(400);
    const badBody = await badRes.json<{ error: string; recipient: string }>();
    expect(badBody.error).toBe('unknown_internal_recipient');
    expect(badBody.recipient).toBe('ghost@miseroda.com');

    /* ---- 富文本：消毒後直送 ---- */
    const richRes = await apiCall('/messages/send', hon.cookies, envS, {
      body: {
        to: ['tom@miseroda.com'],
        subject: '富文本',
        text: 'bold',
        html: '<p><b>bold</b><script>alert(1)</script><a href="javascript:x">bad</a></p>',
        undoWindowSec: 0,
      },
    });
    const { id: sq5 } = await richRes.json<{ id: string }>();
    await runSend(sq5, envS);
    const tomInbox3 = await (await apiCall('/messages?folder=inbox', tom.cookies, envS)).json<{ items: { id: string; subject: string }[] }>();
    const richMsg = tomInbox3.items.find((i) => i.subject === '富文本')!;
    const detail = await (await apiCall(`/messages/${richMsg.id}`, tom.cookies, envS)).json<{ thread: { html: string }[] }>();
    const html = detail.thread[detail.thread.length - 1].html;
    expect(html).toContain('<b>bold</b>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });

  it('vacation auto-reply: internal trigger, throttle, bulk/noreply skip', async () => {
    const { enqueued, envS } = stubEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const tom = await seedUser(env, 'tom@miseroda.com');
    // tom 開假期回覆
    await env.DB.prepare(`INSERT OR REPLACE INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', ?, ?)`)
      .bind(tom.userId, JSON.stringify({ vacation: { on: true, body: '我在小琉球潛水，回來再回信 🐧' } }), Date.now())
      .run();

    // hon → tom 站內信觸發自動回覆（enqueue 一筆 tom→hon 的 send）
    const r1 = await apiCall('/messages/send', hon.cookies, envS, {
      body: { to: ['tom@miseroda.com'], subject: '在嗎', text: 'hi', undoWindowSec: 0 },
    });
    const { id: s1 } = await r1.json<{ id: string }>();
    await runSend(s1, envS);
    const vacSends = enqueued.filter((e) => e.kind === 'send' && e.sendQueueId !== s1);
    expect(vacSends).toHaveLength(1);
    const vacRow = await env.DB.prepare(`SELECT user_id, payload FROM send_queue WHERE id = ?`)
      .bind(vacSends[0].sendQueueId)
      .first<{ user_id: string; payload: string }>();
    expect(vacRow!.user_id).toBe(tom.userId);
    const vacPayload = JSON.parse(vacRow!.payload) as { to: string[]; subject: string };
    expect(vacPayload.to).toEqual(['hon@miseroda.com']);
    expect(vacPayload.subject).toContain('自動回覆');

    // 跑這筆自動回覆 → hon 收件匣出現
    await runSend(vacSends[0].sendQueueId!, envS);
    const honInbox = await (await apiCall('/messages?folder=inbox', hon.cookies, envS)).json<{ items: { subject: string }[] }>();
    expect(honInbox.items.some((i) => i.subject.includes('自動回覆'))).toBe(true);

    // 4 天節流：同寄件人再寄不再回
    const r2 = await apiCall('/messages/send', hon.cookies, envS, {
      body: { to: ['tom@miseroda.com'], subject: '又來', text: 'hi2', undoWindowSec: 0 },
    });
    const { id: s2 } = await r2.json<{ id: string }>();
    const before = enqueued.length;
    await runSend(s2, envS);
    expect(enqueued.length).toBe(before); // 無新增 vacation enqueue

    // 清單信不回：外部 ingest 帶 List-Unsubscribe
    await worker.email(
      mockEmailMessage(
        plainEmail({ to: 'tom@miseroda.com', from: 'news@example.com', subject: '電子報', extraHeaders: ['List-Unsubscribe: <https://x>'] }),
        { to: 'tom@miseroda.com', from: 'news@example.com' },
      ).message,
      envS,
      createExecutionContext(),
    );
    const tomMsg = await env.DB.prepare(
      `SELECT id FROM messages WHERE user_id = ? AND direction='inbound' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(tom.userId)
      .first<{ id: string }>();
    const ibatch = createMessageBatch('miseroda-ingest', [
      { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'ingest', messageId: tomMsg!.id, userId: tom.userId }, attempts: 1 },
    ]);
    const ictx = createExecutionContext();
    const before2 = enqueued.length;
    await worker.queue(ibatch, envS, ictx);
    await getQueueResult(ibatch, ictx);
    expect(enqueued.length).toBe(before2); // bulk 不觸發

    // noreply 寄件人不回
    await worker.email(
      mockEmailMessage(plainEmail({ to: 'tom@miseroda.com', from: 'noreply@example.com', subject: '系統通知' }), { to: 'tom@miseroda.com', from: 'noreply@example.com' }).message,
      envS,
      createExecutionContext(),
    );
    const tomMsg2 = await env.DB.prepare(
      `SELECT id FROM messages WHERE user_id = ? AND direction='inbound' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(tom.userId)
      .first<{ id: string }>();
    const ibatch2 = createMessageBatch('miseroda-ingest', [
      { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'ingest', messageId: tomMsg2!.id, userId: tom.userId }, attempts: 1 },
    ]);
    const ictx2 = createExecutionContext();
    const before3 = enqueued.length;
    await worker.queue(ibatch2, envS, ictx2);
    await getQueueResult(ibatch2, ictx2);
    expect(enqueued.length).toBe(before3);
  });

  it('toContains rule matches plus-alias on internal delivery', async () => {
    const { envS } = stubEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const tom = await seedUser(env, 'tom@miseroda.com');
    await env.DB.prepare(`INSERT INTO labels (id, user_id, name, color, created_at) VALUES ('lbl_alias', ?, '購物', '#FBD46D', ?)`)
      .bind(tom.userId, Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at)
       VALUES ('rul_alias', ?, '別名歸檔', ?, ?, 1, 0, ?)`,
    )
      .bind(tom.userId, JSON.stringify({ toContains: 'tom+shop@' }), JSON.stringify({ addLabelId: 'lbl_alias' }), Date.now())
      .run();

    const r = await apiCall('/messages/send', hon.cookies, envS, {
      body: { to: ['tom@miseroda.com'], cc: [], subject: '訂單', text: 'x', undoWindowSec: 0 },
    });
    // 模擬 to 含別名：直接寄給 tom+shop 不行（內部驗證會擋非使用者），所以測引擎層
    const { id } = await r.json<{ id: string }>();
    await runSend(id, envS);
    // 引擎以 to_addrs 比對：手動投遞一封 to 含別名的
    const { deliverInternal } = await import('../../src/worker/email/deliver');
    await deliverInternal(envS, {
      recipientUserId: tom.userId,
      fromAddr: 'shop@example.com',
      fromName: 'Shop',
      toAddrs: ['tom+shop@miseroda.com'],
      ccAddrs: [],
      subject: '您的訂單',
      html: '<p>訂單</p>',
      text: '訂單',
      messageIdHeader: '<alias-test@miseroda.com>',
      inReplyTo: null,
      references: null,
      attachments: [],
      timestamp: Date.now(),
    });
    const tagged = await env.DB.prepare(
      `SELECT ml.label_id FROM message_labels ml JOIN messages m ON m.id = ml.message_id
       WHERE m.user_id = ? AND m.subject = '您的訂單'`,
    )
      .bind(tom.userId)
      .first<{ label_id: string }>();
    expect(tagged?.label_id).toBe('lbl_alias');
  });
});
