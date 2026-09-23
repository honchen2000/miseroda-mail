// 寄信管線測試：send API → sendQueue → consumer（claim/undo/錯誤分類）→ 寄件備份
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { plainEmail, mockEmailMessage, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

type SendCall = Record<string, unknown> & { to: string[]; subject: string; headers?: Record<string, string> };

// 重要：測試一律用 stub env —— 真的 SEND_QUEUE producer 會讓 miniflare 在測試結束後
// 才投遞（delaySeconds），觸發 isolated-storage 殘留。投遞全部手動 createMessageBatch。
function stubSendEnv(behavior?: 'ok' | 'transient' | 'permanent') {
  const calls: SendCall[] = [];
  const stub = {
    async send(opts: SendCall) {
      calls.push(opts);
      if (behavior === 'transient') {
        const err = new Error('rate limited') as Error & { code: string };
        err.code = 'E_RATE_LIMIT_EXCEEDED';
        throw err;
      }
      if (behavior === 'permanent') {
        const err = new Error('suppressed') as Error & { code: string };
        err.code = 'E_RECIPIENT_SUPPRESSED';
        throw err;
      }
      return { messageId: `<provider-${calls.length}@cf>` };
    },
  };
  const enqueued: unknown[] = [];
  const envSend = {
    ...env,
    SEND_EMAIL: stub,
    SEND_QUEUE: { send: async (body: unknown) => void enqueued.push(body) },
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as typeof env;
  return { calls, enqueued, envSend };
}

async function apiCall(
  path: string,
  cookies: { session: string; csrf: string },
  targetEnv: typeof env,
  opts: { method?: string; body?: unknown; form?: FormData } = {},
) {
  const headers: Record<string, string> = {
    Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
    'X-CSRF-Token': cookies.csrf,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const ctx = createExecutionContext();
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
      headers,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }),
    targetEnv,
    ctx,
  );
}

async function runSendConsumer(sendQueueId: string, targetEnv: typeof env) {
  const batch = createMessageBatch('miseroda-send', [
    { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'send', sendQueueId }, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, targetEnv, ctx);
  return getQueueResult(batch, ctx);
}

async function queueStatus(id: string) {
  const row = await env.DB.prepare(`SELECT status, last_error, message_id FROM send_queue WHERE id = ?`)
    .bind(id)
    .first<{ status: string; last_error: string | null; message_id: string | null }>();
  return row!;
}

describe('send pipeline', () => {
  it('end-to-end: queue → consumer → sent folder, undo, errors, drafts, uploads', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const { calls, envSend } = stubSendEnv('ok');

    /* ---- 附件上傳（staged） ---- */
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', { type: 'image/png' }));
    const upRes = await apiCall('/attachments/upload', hon.cookies, envSend, { form });
    expect(upRes.status).toBe(200);
    const up = await upRes.json<{ id: string; sizeBytes: number }>();
    expect(up.sizeBytes).toBe(4);

    /* ---- 寄出（undo window 15s） ---- */
    const sendRes = await apiCall('/messages/send', hon.cookies, envSend, {
      body: {
        to: ['friend@example.com'],
        subject: '測試寄出',
        text: '哈囉！這封信帶附件。',
        attachmentIds: [up.id],
        undoWindowSec: 15,
      },
    });
    expect(sendRes.status).toBe(200);
    const send = await sendRes.json<{ id: string; undoWindowSec: number }>();
    expect(send.undoWindowSec).toBe(15);
    expect((await queueStatus(send.id)).status).toBe('scheduled');

    /* ---- consumer 寄出 ---- */
    const result = await runSendConsumer(send.id, envSend);
    expect(result.retryMessages).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual(['friend@example.com']);
    expect(calls[0].from).toMatchObject({ email: 'hon@miseroda.com' });
    expect((calls[0].attachments as unknown[]).length).toBe(1);

    const sent = await queueStatus(send.id);
    expect(sent.status).toBe('sent');
    expect(sent.message_id).toBeTruthy();

    // 寄件備份落地
    const sentMsg = await env.DB.prepare(
      `SELECT * FROM messages WHERE id = ?`,
    )
      .bind(sent.message_id)
      .first<{ folder: string; direction: string; subject: string; has_attachments: number }>();
    expect(sentMsg).toMatchObject({ folder: 'sent', direction: 'outbound', subject: '測試寄出', has_attachments: 1 });
    // 附件已綁定訊息
    const boundAtt = await env.DB.prepare(`SELECT message_id FROM attachments WHERE id = ?`)
      .bind(up.id)
      .first<{ message_id: string }>();
    expect(boundAtt!.message_id).toBe(sent.message_id);

    /* ---- 重複投遞：claim 防雙寄 ---- */
    await runSendConsumer(send.id, envSend);
    expect(calls).toHaveLength(1);

    /* ---- Undo：取消後 consumer 跳過 ---- */
    const send2Res = await apiCall('/messages/send', hon.cookies, envSend, {
      body: { to: ['friend@example.com'], subject: '會被收回', text: '...' },
    });
    const send2 = await send2Res.json<{ id: string }>();
    const cancelRes = await apiCall(`/send/${send2.id}/cancel`, hon.cookies, envSend, { method: 'POST', body: {} });
    expect(cancelRes.status).toBe(200);
    const cancelBody = await cancelRes.json<{ payload: { subject: string } }>();
    expect(cancelBody.payload.subject).toBe('會被收回');
    await runSendConsumer(send2.id, envSend);
    expect(calls).toHaveLength(1); // 沒有第二次 send
    expect((await queueStatus(send2.id)).status).toBe('canceled');
    // 太晚取消 → 409
    const lateCancel = await apiCall(`/send/${send.id}/cancel`, hon.cookies, envSend, { method: 'POST', body: {} });
    expect(lateCancel.status).toBe(409);

    /* ---- 回覆串接：In-Reply-To/References 帶上 ---- */
    await worker.email(
      mockEmailMessage(plainEmail({ subject: '原始信', messageId: '<orig-1@example.com>' })).message,
      envSend,
      createExecutionContext(),
    );
    const orig = await env.DB.prepare(
      `SELECT id, thread_id FROM messages WHERE user_id = ? AND subject = '原始信'`,
    )
      .bind(hon.userId)
      .first<{ id: string; thread_id: string }>();
    const replyRes = await apiCall('/messages/send', hon.cookies, envSend, {
      body: {
        to: ['friend@example.com'],
        subject: 'Re: 原始信',
        text: '回覆內容',
        replyToMessageId: orig!.id,
        undoWindowSec: 0,
      },
    });
    const reply = await replyRes.json<{ id: string }>();
    await runSendConsumer(reply.id, envSend);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers?.['In-Reply-To']).toBe('<orig-1@example.com>');
    expect(calls[1].headers?.['References']).toContain('<orig-1@example.com>');
    // 回覆與原信同 thread
    const replyMsgId = (await queueStatus(reply.id)).message_id;
    const replyMsg = await env.DB.prepare(`SELECT thread_id FROM messages WHERE id = ?`)
      .bind(replyMsgId)
      .first<{ thread_id: string }>();
    expect(replyMsg!.thread_id).toBe(orig!.thread_id);

    /* ---- 暫時性錯誤：還原 scheduled + retry ---- */
    const t = stubSendEnv('transient');
    const sendT = await (
      await apiCall('/messages/send', hon.cookies, envSend, {
        body: { to: ['x@example.com'], subject: 't', text: 't', undoWindowSec: 0 },
      })
    ).json<{ id: string }>();
    const tResult = await runSendConsumer(sendT.id, t.envSend);
    expect(tResult.retryMessages.length).toBe(1);
    expect((await queueStatus(sendT.id)).status).toBe('scheduled');

    /* ---- 永久錯誤：failed，不重試 ---- */
    const p = stubSendEnv('permanent');
    const sendP = await (
      await apiCall('/messages/send', hon.cookies, envSend, {
        body: { to: ['suppressed@example.com'], subject: 'p', text: 'p', undoWindowSec: 0 },
      })
    ).json<{ id: string }>();
    const pResult = await runSendConsumer(sendP.id, p.envSend);
    expect(pResult.retryMessages).toHaveLength(0);
    const pStatus = await queueStatus(sendP.id);
    expect(pStatus.status).toBe('failed');
    expect(pStatus.last_error).toContain('E_RECIPIENT_SUPPRESSED');

    /* ---- Outbox：失敗的信出現在 outbox，且可重寄 ---- */
    const outbox = await (await apiCall('/outbox', hon.cookies, envSend)).json<{ items: { id: string; status: string }[] }>();
    const failedItem = outbox.items.find((o) => o.id === sendP.id);
    expect(failedItem?.status).toBe('failed');
    const retryRes = await apiCall(`/send/${sendP.id}/retry`, hon.cookies, envSend, { method: 'POST', body: {} });
    expect(retryRes.status).toBe(200);
    await retryRes.json();
    expect((await queueStatus(sendP.id)).status).toBe('scheduled');
    // 非失敗狀態不可重寄
    const retryAgain = await apiCall(`/send/${sendP.id}/retry`, hon.cookies, envSend, { method: 'POST', body: {} });
    expect(retryAgain.status).toBe(409);
    await retryAgain.json();

    /* ---- 下載原始郵件 .eml（用前面 ingest 的「原始信」，有 r2_raw_key） ---- */
    const rawRes = await apiCall(`/messages/${orig!.id}/raw`, hon.cookies, envSend);
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get('Content-Type')).toBe('message/rfc822');
    expect(rawRes.headers.get('Content-Disposition')).toContain('.eml');
    expect((await rawRes.text()).length).toBeGreaterThan(0);
    // 寄件備份沒有 r2_raw_key → 404
    const sentRaw = await apiCall(`/messages/${sent.message_id}/raw`, hon.cookies, envSend);
    expect(sentRaw.status).toBe(404);
    await sentRaw.text();

    /* ---- 5MiB 守門 ---- */
    const bigRes = await apiCall('/messages/send', hon.cookies, envSend, {
      body: { to: ['x@example.com'], subject: 'big', text: 'x'.repeat(1_900_000) },
    });
    expect(bigRes.status).toBe(200); // 1.9MB 字串 OK
    const tooBig = await apiCall('/messages/send', hon.cookies, envSend, {
      body: { to: ['x@example.com'], subject: 'big', text: 'x'.repeat(2_000_001) },
    });
    expect(tooBig.status).toBe(400); // zod max 2_000_000 先擋（5MiB 守門對附件總量）

    /* ---- 排程寄送：cron sweep enqueue ---- */
    const futureRes = await apiCall('/messages/send', hon.cookies, envSend, {
      body: { to: ['later@example.com'], subject: '排程信', text: '排程內容', scheduleAt: Date.now() + 3600_000 },
    });
    expect(futureRes.status).toBe(200);
    const future = await futureRes.json<{ id: string }>();
    expect((await queueStatus(future.id)).status).toBe('scheduled');
    // 把時間改成已到期 → sweep 應 enqueue（claim 仍 scheduled，由 consumer 處理）
    await env.DB.prepare(`UPDATE send_queue SET scheduled_at = ? WHERE id = ?`)
      .bind(Date.now() - 1000, future.id)
      .run();
    const { sweep } = await import('../../src/worker/jobs/sweep');
    await sweep(envSend); // enqueue 不會丟錯即可；本地 queue 不自動投遞，手動跑 consumer
    await runSendConsumer(future.id, envSend);
    expect((await queueStatus(future.id)).status).toBe('sent');

    /* ---- 草稿 CRUD ---- */
    const draftRes = await apiCall('/drafts', hon.cookies, envSend, {
      body: { to: 'a@b.com', subject: '草稿', body: '內容', attachments: [], replyToMessageId: null },
    });
    const draft = await draftRes.json<{ id: string }>();
    const patchDraft = await apiCall(`/drafts/${draft.id}`, hon.cookies, envSend, {
      method: 'PATCH',
      body: { to: 'a@b.com', subject: '草稿改', body: '內容2', attachments: [], replyToMessageId: null },
    });
    expect(patchDraft.status).toBe(200);
    const list = await (await apiCall('/drafts', hon.cookies, envSend)).json<{ drafts: { id: string; payload: { subject: string } }[] }>();
    expect(list.drafts.find((d) => d.id === draft.id)?.payload.subject).toBe('草稿改');
    const delDraft = await apiCall(`/drafts/${draft.id}`, hon.cookies, envSend, { method: 'DELETE' });
    expect(delDraft.status).toBe(200);

    /* ---- staged 附件刪除 ---- */
    const form2 = new FormData();
    form2.set('file', new File(['abc'], 'note.txt', { type: 'text/plain' }));
    const up2 = await (await apiCall('/attachments/upload', hon.cookies, envSend, { form: form2 })).json<{ id: string }>();
    const delAtt = await apiCall(`/attachments/${up2.id}`, hon.cookies, envSend, { method: 'DELETE' });
    expect(delAtt.status).toBe(200);

    /* ---- 跨使用者：別人不能取消我的寄送 ---- */
    const kai = await seedUser(env, 'kai@miseroda.com');
    const mySend = await (
      await apiCall('/messages/send', hon.cookies, envSend, {
        body: { to: ['x@example.com'], subject: 'mine', text: 'mine' },
      })
    ).json<{ id: string }>();
    const crossCancel = await apiCall(`/send/${mySend.id}/cancel`, kai.cookies, envSend, { method: 'POST', body: {} });
    expect(crossCancel.status).toBe(409);
  });

  // 停用即撤銷未消化的寄送：停用當下作廢 session／信任裝置，但 send_queue 列照舊 —— consumer 必須自己再確認寄件身分仍有效
  it('帳號停用後：已排入的信不再寄出（重新啟用可自 outbox 重寄）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const { calls, envSend } = stubSendEnv('ok');

    const queued = await (
      await apiCall('/messages/send', hon.cookies, envSend, {
        body: { to: ['friend@example.com'], subject: '停用前排入', text: '內容', undoWindowSec: 0 },
      })
    ).json<{ id: string }>();

    // admin 停用（PATCH /admin/users/:id 的效果；該路徑不動 send_queue）
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).bind(hon.userId).run();

    await runSendConsumer(queued.id, envSend);
    expect(calls).toHaveLength(0); // 沒有任何外送
    const blocked = await queueStatus(queued.id);
    expect(blocked.status).toBe('failed');
    expect(blocked.last_error).toBe('user_disabled');
    expect(blocked.message_id).toBeNull(); // 寄件備份也沒落地

    // 重新啟用 → 信還在，使用者可自 outbox 重寄
    await env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(hon.userId).run();
    const retry = await apiCall(`/send/${queued.id}/retry`, hon.cookies, envSend, { method: 'POST', body: {} });
    expect(retry.status).toBe(200);
    await runSendConsumer(queued.id, envSend);
    expect(calls).toHaveLength(1);
    expect((await queueStatus(queued.id)).status).toBe('sent');
  });
});
