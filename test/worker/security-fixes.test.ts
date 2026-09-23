// 對抗式審查四項修復的回歸測試：
// F1 伺服器端強制 TOTP + 信任裝置；F2 /totp/setup 已啟用拒重設；
// F3 內部信附件每收件人複製（刪寄件者不毀附件）；F4 寄送冪等（重寄不重發/不重複）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, createScheduledController, env, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { generateTotpSecret, totpCode } from '../../src/worker/auth/totp';
import { aesGcmEncrypt } from '../../src/worker/lib/crypto';
import { createChallenge, isTrustedDevice } from '../../src/worker/auth/sessions';

const BASE = 'https://mail.miseroda.com/api/v1';

// 佇列一律 noop：/send/:id/resolve（resend／sent）用真 env 時，真 SEND_QUEUE 會讓 miniflare 在背景自動投遞，
// consumer 跑在 it() 之外、打到已回滾的 storage frame（no such table: send_queue → Isolated storage failed）。
// 寄送一律由 runSend 手動跑 consumer（L5／L14）。SEND_EMAIL 等其餘 binding 原樣沿用 targetEnv。
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
  const quietEnv = {
    ...targetEnv,
    SEND_QUEUE: { send: async () => {} },
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as typeof env;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
      headers,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }),
    quietEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx); // waitUntil（新裝置偵測、邊緣快取寫入）在 it() 內收完
  return res;
}

function stubSendEnv(behavior: 'ok' | 'permanent' | 'transient' | 'ambiguous' | 'unknown' = 'ok') {
  const calls: { to: string[] }[] = [];
  const stub = {
    async send(opts: { to: string[] }) {
      calls.push(opts);
      if (behavior === 'permanent') {
        const err = new Error('suppressed') as Error & { code: string };
        err.code = 'E_RECIPIENT_SUPPRESSED';
        throw err;
      }
      if (behavior === 'transient') {
        const err = new Error('rate limited') as Error & { code: string };
        err.code = 'E_RATE_LIMIT_EXCEEDED';
        throw err;
      }
      if (behavior === 'ambiguous') {
        // 5xx：provider 可能已接受才回應失敗 → 結果未定
        const err = new Error('internal') as Error & { code: string };
        err.code = 'E_INTERNAL_SERVER_ERROR';
        throw err;
      }
      if (behavior === 'unknown') {
        // 裸逾時：無 .code → 預設 E_UNKNOWN → 結果未定（最可能的「已接受但沒看到 ack」情境）
        throw new Error('socket timeout');
      }
      return { messageId: `<provider-${calls.length}@cf>` };
    },
  };
  const envSend = {
    ...env,
    SEND_EMAIL: stub,
    SEND_QUEUE: { send: async () => {} },
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as typeof env;
  return { calls, envSend };
}

async function runSend(sendQueueId: string, targetEnv: typeof env) {
  const batch = createMessageBatch('miseroda-send', [
    { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'send', sendQueueId }, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, targetEnv, ctx);
  return getQueueResult(batch, ctx);
}

async function setTotpEnabled(userId: string, enabled: 0 | 1) {
  await env.DB.prepare(`UPDATE totp_secrets SET enabled = ? WHERE user_id = ?`).bind(enabled, userId).run();
}

/* ================= F1：伺服器端強制 TOTP ================= */

describe('F1 MFA enforcement', () => {
  it('未啟用 TOTP 者被擋在入會流程內（保護路由 403、設定端點放行）', async () => {
    const u = await seedUser(env, 'kai@miseroda.com');
    await setTotpEnabled(u.userId, 0); // 模擬尚未完成入會

    // 保護路由：mfa_setup_required
    const counts = await apiCall('/mailbox/counts', u.cookies, env);
    expect(counts.status).toBe(403);
    expect((await counts.json<{ error: string }>()).error).toBe('mfa_setup_required');

    const labels = await apiCall('/labels', u.cookies, env, { body: { name: 'x', color: '#FFFFFF' } });
    expect(labels.status).toBe(403);

    // 入會所需端點：放行
    expect((await apiCall('/auth/me', u.cookies, env)).status).toBe(200);
    expect((await apiCall('/auth/totp/setup', u.cookies, env, { body: {} })).status).toBe(200);

    // 完成入會後解鎖
    await setTotpEnabled(u.userId, 1);
    expect((await apiCall('/mailbox/counts', u.cookies, env)).status).toBe(200);
  });

  it('信任裝置：通過 TOTP 並勾選後發 __Host-device，停用使用者即作廢', async () => {
    const u = await seedUser(env, 'trust@miseroda.com');
    // 放入已知的 TOTP secret
    const secret = generateTotpSecret();
    await env.DB.prepare(`UPDATE totp_secrets SET secret_enc = ?, enabled = 1 WHERE user_id = ?`)
      .bind(await aesGcmEncrypt(env.TOTP_ENC_KEY, secret), u.userId)
      .run();
    const totpToken = await createChallenge(env, 'totp_login', JSON.stringify({ attempts: 0 }), u.userId);

    const res = await apiCall('/auth/totp/challenge', u.cookies, env, {
      body: { totpToken, code: await totpCode(secret, Date.now()), trustDevice: true },
    });
    expect(res.status).toBe(200);
    const deviceCookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-device='));
    expect(deviceCookie).toBeTruthy();
    const token = decodeURIComponent(deviceCookie!.split(';')[0].split('=')[1]);

    // 伺服器端可驗證為有效信任裝置；換使用者則否
    expect(await isTrustedDevice(env, u.userId, token)).toBe(true);
    expect(await isTrustedDevice(env, 'usr_other', token)).toBe(false);
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM trusted_devices WHERE user_id = ?`).bind(u.userId).first<{ n: number }>();
    expect(cnt?.n).toBe(1);

    // admin 停用該帳號 → 信任裝置作廢
    const admin = await seedUser(env, 'root@miseroda.com', 'admin');
    expect((await apiCall(`/admin/users/${u.userId}`, admin.cookies, env, { method: 'PATCH', body: { status: 'disabled' } })).status).toBe(200);
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM trusted_devices WHERE user_id = ?`).bind(u.userId).first<{ n: number }>();
    expect(after?.n).toBe(0);
  });
});

/* ================= F2：/totp/setup 已啟用拒重設 ================= */

describe('F2 totp setup guard', () => {
  it('已啟用回 409 且不覆寫 secret；未啟用才允許重建', async () => {
    const u = await seedUser(env, 'ada@miseroda.com'); // seedUser 預設 enabled=1, secret_enc='x'
    const before = await env.DB.prepare(`SELECT secret_enc FROM totp_secrets WHERE user_id = ?`).bind(u.userId).first<{ secret_enc: string }>();
    const res = await apiCall('/auth/totp/setup', u.cookies, env, { body: {} });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('totp_already_enabled');
    const after = await env.DB.prepare(`SELECT secret_enc, enabled FROM totp_secrets WHERE user_id = ?`).bind(u.userId).first<{ secret_enc: string; enabled: number }>();
    expect(after?.secret_enc).toBe(before?.secret_enc); // 未被覆寫
    expect(after?.enabled).toBe(1); // 仍啟用

    // 未啟用時允許
    await setTotpEnabled(u.userId, 0);
    expect((await apiCall('/auth/totp/setup', u.cookies, env, { body: {} })).status).toBe(200);
  });
});

/* ================= F3：內部信附件每收件人複製 ================= */

describe('F3 internal attachment ownership', () => {
  it('刪除寄件者帳號後，收件人仍可下載內部信附件', async () => {
    const admin = await seedUser(env, 'root@miseroda.com', 'admin');
    const sender = await seedUser(env, 'sender@miseroda.com');
    const recipient = await seedUser(env, 'recv@miseroda.com');
    const { envSend } = stubSendEnv();

    // 寄件者上傳附件
    const form = new FormData();
    form.set('file', new File([new Uint8Array([9, 8, 7, 6, 5])], 'report.pdf', { type: 'application/pdf' }));
    const up = await (await apiCall('/attachments/upload', sender.cookies, envSend, { form })).json<{ id: string }>();

    // 寄純內部信給收件人（夾帶附件）
    const send = await apiCall('/messages/send', sender.cookies, envSend, {
      body: { to: ['recv@miseroda.com'], subject: '報表', text: '請查收', attachmentIds: [up.id], undoWindowSec: 0 },
    });
    expect(send.status).toBe(200);
    await runSend((await send.json<{ id: string }>()).id, envSend);

    // 收件人的附件 row：key 應在自己的 att/ 前綴下（非寄件者的 upload/）
    const recvAtt = await env.DB.prepare(`SELECT id, r2_key FROM attachments WHERE user_id = ?`).bind(recipient.userId).first<{ id: string; r2_key: string }>();
    expect(recvAtt).toBeTruthy();
    expect(recvAtt!.r2_key.startsWith(`att/${recipient.userId}/`)).toBe(true);

    // 下載一次確認可用
    const dl1 = await apiCall(`/attachments/${recvAtt!.id}`, recipient.cookies, env);
    expect(dl1.status).toBe(200);
    expect(new Uint8Array(await dl1.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7, 6, 5]));

    // 停用 + 永久刪除寄件者
    await apiCall(`/admin/users/${sender.userId}`, admin.cookies, env, { method: 'PATCH', body: { status: 'disabled' } });
    expect((await apiCall(`/admin/users/${sender.userId}`, admin.cookies, env, { method: 'DELETE' })).status).toBe(200);

    // 收件人仍可下載（物件是自己的副本，未被寄件者刪除波及）
    const dl2 = await apiCall(`/attachments/${recvAtt!.id}`, recipient.cookies, env);
    expect(dl2.status).toBe(200);
    expect(new Uint8Array(await dl2.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7, 6, 5]));
  });
});

/* ================= F4：寄送冪等 ================= */

describe('F4 send idempotency', () => {
  it('外送成功後重寄：不重發外部、不重複內部、不重寫寄件備份', async () => {
    const sender = await seedUser(env, 'biz@miseroda.com');
    await seedUser(env, 'mate@miseroda.com'); // 內部收件人
    const { calls, envSend } = stubSendEnv();

    const send = await apiCall('/messages/send', sender.cookies, envSend, {
      body: { to: ['outside@gmail.com', 'mate@miseroda.com'], subject: '混合', text: '哈囉', undoWindowSec: 0 },
    });
    const sendId = (await send.json<{ id: string }>()).id;
    await runSend(sendId, envSend);

    expect(calls).toHaveLength(1); // 外送一次
    const externalSentAt = (await env.DB.prepare(`SELECT external_sent_at FROM send_queue WHERE id = ?`).bind(sendId).first<{ external_sent_at: number | null }>())?.external_sent_at;
    expect(externalSentAt).toBeTruthy();
    const mateInbox1 = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE from_addr = 'biz@miseroda.com' AND folder = 'inbox'`).first<{ n: number }>())?.n;
    expect(mateInbox1).toBe(1);
    const sent1 = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND direction = 'outbound'`).bind(sender.userId).first<{ n: number }>())?.n;
    expect(sent1).toBe(1);

    // 模擬「落地後局部失敗 → 使用者手動重寄」：狀態重置為 scheduled，external_sent_at 保留，再跑一次
    await env.DB.prepare(`UPDATE send_queue SET status = 'scheduled', message_id = NULL WHERE id = ?`).bind(sendId).run();
    await runSend(sendId, envSend);

    expect(calls).toHaveLength(1); // 外送仍只有一次（external_sent_at 守門）
    const mateInbox2 = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE from_addr = 'biz@miseroda.com' AND folder = 'inbox'`).first<{ n: number }>())?.n;
    expect(mateInbox2).toBe(1); // 內部信未重複
    const sent2 = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND direction = 'outbound'`).bind(sender.userId).first<{ n: number }>())?.n;
    expect(sent2).toBe(1); // 寄件備份未重複
    const finalStatus = (await env.DB.prepare(`SELECT status FROM send_queue WHERE id = ?`).bind(sendId).first<{ status: string }>())?.status;
    expect(finalStatus).toBe('sent');
  });

  it('C1/D1：外送失敗時 external_sent_at 維持 NULL（標記僅在成功後寫，重寄能重新送）', async () => {
    const sender = await seedUser(env, 'c1@miseroda.com');
    const { calls, envSend } = stubSendEnv('permanent');
    const send = await apiCall('/messages/send', sender.cookies, envSend, {
      body: { to: ['outside@gmail.com'], subject: '退信', text: 'hi', undoWindowSec: 0 },
    });
    const sendId = (await send.json<{ id: string }>()).id;
    await runSend(sendId, envSend);

    expect(calls).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status, external_sent_at FROM send_queue WHERE id = ?`).bind(sendId).first<{ status: string; external_sent_at: number | null }>();
    expect(row?.status).toBe('failed');
    expect(row?.external_sent_at).toBeNull(); // 已回滾 → 重寄不會被守門誤跳過
  });

  it('C2：純內部信附件來源遺失 → fail-closed 標記失敗，不靜默漏附件', async () => {
    const sender = await seedUser(env, 'c2@miseroda.com');
    const recipient = await seedUser(env, 'c2r@miseroda.com');
    const { envSend } = stubSendEnv();

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 1, 2, 3])], 'doc.pdf', { type: 'application/pdf' }));
    const up = await (await apiCall('/attachments/upload', sender.cookies, envSend, { form })).json<{ id: string }>();
    // 模擬來源物件遺失（D1 row 還在、R2 bytes 不見）
    const att = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?`).bind(up.id).first<{ r2_key: string }>();
    await env.MAIL_STORE.delete(att!.r2_key);

    const send = await apiCall('/messages/send', sender.cookies, envSend, {
      body: { to: ['c2r@miseroda.com'], subject: '附件', text: '請查收', attachmentIds: [up.id], undoWindowSec: 0 },
    });
    const sendId = (await send.json<{ id: string }>()).id;
    await runSend(sendId, envSend);

    const status = (await env.DB.prepare(`SELECT status, last_error FROM send_queue WHERE id = ?`).bind(sendId).first<{ status: string; last_error: string | null }>());
    expect(status?.status).toBe('failed'); // 不是 sent
    expect(status?.last_error).toContain('attachment_source_missing');
    // 收件人沒有半封「有迴紋針卻點不開」的信
    const recvMsgs = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ n: number }>())?.n;
    expect(recvMsgs).toBe(0);
  });

  it('C3：重寄重跑收尾步驟為冪等（不重複訊息、thread 不重複計數、FTS 有索引）', async () => {
    const sender = await seedUser(env, 'c3@miseroda.com');
    const recipient = await seedUser(env, 'c3r@miseroda.com');
    const { envSend } = stubSendEnv();

    const send = await apiCall('/messages/send', sender.cookies, envSend, {
      body: { to: ['c3r@miseroda.com'], subject: '冪等測試', text: '搜尋關鍵字 watermelon', undoWindowSec: 0 },
    });
    const sendId = (await send.json<{ id: string }>()).id;
    await runSend(sendId, envSend);

    const recvMsg = await env.DB.prepare(`SELECT id, thread_id FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ id: string; thread_id: string }>();
    expect(recvMsg).toBeTruthy();
    const count1 = (await env.DB.prepare(`SELECT message_count FROM threads WHERE id = ?`).bind(recvMsg!.thread_id).first<{ message_count: number }>())?.message_count;
    expect(count1).toBe(1);

    // 模擬「落地後局部失敗 → 使用者重寄」：重跑同一封
    await env.DB.prepare(`UPDATE send_queue SET status = 'scheduled', message_id = NULL WHERE id = ?`).bind(sendId).run();
    await runSend(sendId, envSend);

    // 收件人仍只有一封（dedup）
    const recvN = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ n: number }>())?.n;
    expect(recvN).toBe(1);
    // thread 計數沒有變成 2（bumpThread 重算而非 +1）
    const count2 = (await env.DB.prepare(`SELECT message_count FROM threads WHERE id = ?`).bind(recvMsg!.thread_id).first<{ message_count: number }>())?.message_count;
    expect(count2).toBe(1);
    // FTS 索引存在（收尾步驟有冪等重跑）
    const mapped = (await env.DB_FTS.prepare(`SELECT COUNT(*) AS n FROM msg_map WHERE message_id = ?`).bind(recvMsg!.id).first<{ n: number }>())?.n;
    expect(mapped).toBe(1);
  });

  it('D2：附件 row 消失（防禦縱深）→ 消費端 fail-closed，不寄出漏附件的信', async () => {
    const sender = await seedUser(env, 'd2@miseroda.com');
    const recipient = await seedUser(env, 'd2r@miseroda.com');
    const { envSend } = stubSendEnv();

    const form = new FormData();
    form.set('file', new File([new Uint8Array([5, 5, 5])], 'slip.pdf', { type: 'application/pdf' }));
    const up = await (await apiCall('/attachments/upload', sender.cookies, envSend, { form })).json<{ id: string }>();

    const send = await apiCall('/messages/send', sender.cookies, envSend, {
      body: { to: ['d2r@miseroda.com'], subject: '單據', text: '附上', attachmentIds: [up.id], undoWindowSec: 0 },
    });
    const sendId = (await send.json<{ id: string }>()).id;

    // 直接刪 D1 row（繞過 E2 API 守門，模擬附件 row 以其他途徑消失）
    await env.DB.prepare(`DELETE FROM attachments WHERE id = ?`).bind(up.id).run();

    await runSend(sendId, envSend);

    const st = await env.DB.prepare(`SELECT status, last_error FROM send_queue WHERE id = ?`).bind(sendId).first<{ status: string; last_error: string | null }>();
    expect(st?.status).toBe('failed'); // 不是 sent
    expect(st?.last_error).toContain('attachment_missing');
    const recvN = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ n: number }>())?.n;
    expect(recvN).toBe(0); // 收件人沒收到漏附件的信
  });

  // 直接植入一筆 send_queue 列（指定 status / external_state）以驗證狀態機分支
  async function insertSend(
    sendId: string,
    userId: string,
    to: string[],
    opts: { status?: string; external_state?: string | null; external_sent_at?: number | null; attachmentIds?: string[] } = {},
  ) {
    const now = Date.now();
    const payload = JSON.stringify({ to, cc: [], bcc: [], subject: '狀態機', text: '內文', html: null, attachmentIds: opts.attachmentIds ?? [], inReplyTo: null, references: null, replyToMessageId: null });
    await env.DB.prepare(
      `INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at, external_state, external_sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(sendId, userId, payload, opts.status ?? 'scheduled', now, now, opts.external_state ?? null, opts.external_sent_at ?? null)
      .run();
  }

  // 植入一筆最小 message 列（供附件 message_id FK 綁定用）
  async function insertMessage(msgId: string, userId: string) {
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, folder, received_at, created_at)
       VALUES (?, ?, ?, 'outbound', 'x@miseroda.com', 'sent', ?, ?)`,
    )
      .bind(msgId, userId, `thr_${msgId}`, Date.now(), Date.now())
      .run();
  }

  // 植入一筆 staged 附件（含 R2 物件）；messageId 預設 NULL（未綁定，綁定時需先有對應 message 列）
  async function insertAttachment(attId: string, userId: string, opts: { messageId?: string | null } = {}) {
    const key = `upload/${userId}/${attId}`;
    await env.MAIL_STORE.put(key, new Uint8Array([1, 2, 3]));
    await env.DB.prepare(
      `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
       VALUES (?, ?, ?, 'f.bin', 'application/octet-stream', 3, 'attachment', ?, ?)`,
    )
      .bind(attId, opts.messageId ?? null, userId, key, Date.now())
      .run();
  }

  it('狀態機：進場 attempting → 不重送外部，轉「待裁決」(external_uncertain)', async () => {
    const sender = await seedUser(env, 'sm1@miseroda.com');
    const { calls, envSend } = stubSendEnv();
    await insertSend('snd_sm1', sender.userId, ['outside@gmail.com'], { external_state: 'attempting' });
    await runSend('snd_sm1', envSend);

    expect(calls).toHaveLength(0); // 絕不再呼叫 provider
    const row = await env.DB.prepare(`SELECT status, last_error, external_state FROM send_queue WHERE id = 'snd_sm1'`).first<{ status: string; last_error: string; external_state: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('external_uncertain');
    expect(row?.external_state).toBe('attempting'); // 維持，供裁決
  });

  it('狀態機：進場 accepted → 跳過外送，只補本地收尾並標 sent', async () => {
    const sender = await seedUser(env, 'sm2@miseroda.com');
    const recipient = await seedUser(env, 'sm2r@miseroda.com');
    const { calls, envSend } = stubSendEnv();
    await insertSend('snd_sm2', sender.userId, ['sm2r@miseroda.com', 'outside@gmail.com'], { external_state: 'accepted' });
    await runSend('snd_sm2', envSend);

    expect(calls).toHaveLength(0); // 已送過，不再外送
    const st = (await env.DB.prepare(`SELECT status FROM send_queue WHERE id = 'snd_sm2'`).first<{ status: string }>())?.status;
    expect(st).toBe('sent');
    const recvN = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ n: number }>())?.n;
    expect(recvN).toBe(1); // 內部收尾仍完成
  });

  it('狀態機：永久拒收(E_RECIPIENT_SUPPRESSED 確定未接受) → 回滾 NULL + 終態 failed（可修正後重寄、不卡 review）', async () => {
    const sender = await seedUser(env, 'sm3@miseroda.com');
    const { calls, envSend } = stubSendEnv('permanent');
    await insertSend('snd_sm3', sender.userId, ['outside@gmail.com']);
    await runSend('snd_sm3', envSend);

    expect(calls).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status, last_error, external_state FROM send_queue WHERE id = 'snd_sm3'`).first<{ status: string; last_error: string | null; external_state: string | null }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toContain('E_RECIPIENT_SUPPRESSED');
    expect(row?.external_state).toBeNull(); // 確定未接受 → 回滾 → 重寄能重送，且非 review（last_error 非 external_uncertain）
  });

  it('狀態機[F2核心]：結果未定(E_INTERNAL_SERVER_ERROR 可能已接受) → 不回滾、保留 attempting → review，且一般 /retry 被擋、重跑不再外送', async () => {
    const sender = await seedUser(env, 'smamb@miseroda.com');
    const { calls, envSend } = stubSendEnv('ambiguous');
    await insertSend('snd_amb', sender.userId, ['outside@gmail.com']);
    await runSend('snd_amb', envSend);

    expect(calls).toHaveLength(1); // 送過一次（結果未定）
    const row = await env.DB.prepare(`SELECT status, last_error, external_state FROM send_queue WHERE id = 'snd_amb'`).first<{ status: string; last_error: string; external_state: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('external_uncertain');
    expect(row?.external_state).toBe('attempting'); // 關鍵：marker 未被回滾

    // outbox 應判為 review（而非普通 failed）
    const outbox = await (await apiCall('/outbox', sender.cookies, env)).json<{ items: { id: string; status: string }[] }>();
    expect(outbox.items.find((o) => o.id === 'snd_amb')?.status).toBe('review');

    // 一般 /retry 必須被守門擋下（避免一鍵重複外送）
    expect((await apiCall('/send/snd_amb/retry', sender.cookies, env, { body: {} })).status).toBe(409);

    // 即使被 re-enqueue 重跑，也只會轉 review、絕不再外送
    await runSend('snd_amb', envSend);
    expect(calls).toHaveLength(1);
  });

  it('狀態機[F2核心]：裸逾時(E_UNKNOWN) → 同樣保留 attempting → review，不自動重送', async () => {
    const sender = await seedUser(env, 'smunk@miseroda.com');
    const { calls, envSend } = stubSendEnv('unknown');
    await insertSend('snd_unk', sender.userId, ['outside@gmail.com']);
    await runSend('snd_unk', envSend);

    expect(calls).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status, last_error, external_state FROM send_queue WHERE id = 'snd_unk'`).first<{ status: string; last_error: string; external_state: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('external_uncertain');
    expect(row?.external_state).toBe('attempting');
  });

  it('狀態機[內外腿解耦]：混合信外送 ambiguous → 站內已送達 + 寄件備份，整封 review；resolve resend 不重複站內', async () => {
    const sender = await seedUser(env, 'mix@miseroda.com');
    const recipient = await seedUser(env, 'mixr@miseroda.com');
    const amb = stubSendEnv('ambiguous');
    await insertSend('snd_mix', sender.userId, ['mixr@miseroda.com', 'outside@gmail.com']);
    await runSend('snd_mix', amb.envSend);

    expect(amb.calls).toHaveLength(1); // 外送嘗試一次（結果未定）
    // 關鍵：站內收件人已收到（外送卡 review 不再餓死站內腿）
    const recvN = (await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ n: number }>())?.n;
    expect(recvN).toBe(1);
    // 寄件者已有寄件備份
    const sentN = (await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'outbound'`).bind(sender.userId).first<{ n: number }>())?.n;
    expect(sentN).toBe(1);
    // 整封仍正確轉 review（不因站內成功就翻 sent）
    const row = await env.DB.prepare(`SELECT status, last_error, external_state FROM send_queue WHERE id = 'snd_mix'`).first<{ status: string; last_error: string; external_state: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('external_uncertain');
    expect(row?.external_state).toBe('attempting');

    // resolve resend → 重新外送成功；站內與寄件備份都不重複（冪等去重）
    const ok = stubSendEnv('ok');
    expect((await apiCall('/send/snd_mix/resolve', sender.cookies, env, { body: { decision: 'resend' } })).status).toBe(200);
    await runSend('snd_mix', ok.envSend);
    expect(ok.calls).toHaveLength(1); // 外送重送一次
    const recvN2 = (await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ n: number }>())?.n;
    expect(recvN2).toBe(1); // 站內不重複
    const sentN2 = (await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'outbound'`).bind(sender.userId).first<{ n: number }>())?.n;
    expect(sentN2).toBe(1); // 寄件備份不重複
    const st = (await env.DB.prepare(`SELECT status FROM send_queue WHERE id = 'snd_mix'`).first<{ status: string }>())?.status;
    expect(st).toBe('sent'); // 解決後整封 sent
  });

  it('狀態機[內外腿解耦]：混合信外送永久拒收 → 站內仍送達 + 寄件備份，整封 failed', async () => {
    const sender = await seedUser(env, 'mixp@miseroda.com');
    const recipient = await seedUser(env, 'mixpr@miseroda.com');
    const p = stubSendEnv('permanent');
    await insertSend('snd_mixp', sender.userId, ['mixpr@miseroda.com', 'suppressed@gmail.com']);
    await runSend('snd_mixp', p.envSend);

    expect(p.calls).toHaveLength(1);
    const recvN = (await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ n: number }>())?.n;
    expect(recvN).toBe(1); // 站內不被外部永久退信餓死
    const row = await env.DB.prepare(`SELECT status, external_state FROM send_queue WHERE id = 'snd_mixp'`).first<{ status: string; external_state: string | null }>();
    expect(row?.status).toBe('failed');
    expect(row?.external_state).toBeNull(); // 永久拒收 → 回滾
  });

  it('狀態機[純外部 review 不寫幻影]：純外部 ambiguous → 不留 Sent 副本，僅 review；resolve resend 成功後才寫、discard 始終無', async () => {
    const sender = await seedUser(env, 'phantom@miseroda.com');

    // 純外部 + ambiguous → review，且「不」寫寄件備份（避免 outbox review 與 Sent 幻影信的矛盾雙重狀態）
    const amb = stubSendEnv('ambiguous');
    await insertSend('snd_ph', sender.userId, ['outside@gmail.com']);
    await runSend('snd_ph', amb.envSend);
    expect(amb.calls).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status, last_error, external_state FROM send_queue WHERE id = 'snd_ph'`).first<{ status: string; last_error: string; external_state: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('external_uncertain');
    expect(row?.external_state).toBe('attempting'); // 仍 review、不重送
    const sent0 = (await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'outbound'`).bind(sender.userId).first<{ n: number }>())?.n;
    expect(sent0).toBe(0); // 關鍵：外部結果未定前不留 Sent 幻影信

    // resolve discard → 仍然沒有任何 Sent 副本（不會留下孤兒）
    await insertSend('snd_ph2', sender.userId, ['outside2@gmail.com']);
    const amb2 = stubSendEnv('ambiguous');
    await runSend('snd_ph2', amb2.envSend);
    expect((await apiCall('/send/snd_ph2/resolve', sender.cookies, env, { body: { decision: 'discard' } })).status).toBe(200);
    const sentAfterDiscard = (await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'outbound'`).bind(sender.userId).first<{ n: number }>())?.n;
    expect(sentAfterDiscard).toBe(0); // discard 後依然無孤兒 Sent 信

    // resolve resend → 重新外送成功，這時才寫 Sent 副本（確認送出才入 Sent）
    const ok = stubSendEnv('ok');
    expect((await apiCall('/send/snd_ph/resolve', sender.cookies, env, { body: { decision: 'resend' } })).status).toBe(200);
    await runSend('snd_ph', ok.envSend);
    expect(ok.calls).toHaveLength(1);
    const sent1 = (await env.DB.prepare(`SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'outbound'`).bind(sender.userId).first<{ n: number }>())?.n;
    expect(sent1).toBe(1); // 成功後才有 Sent 副本
    const st = (await env.DB.prepare(`SELECT status FROM send_queue WHERE id = 'snd_ph'`).first<{ status: string }>())?.status;
    expect(st).toBe('sent');
  });

  it('狀態機[Fix-1 附件守門]：review 中引用的 staged 附件不可刪（409）', async () => {
    const sender = await seedUser(env, 'attg@miseroda.com');
    await insertAttachment('att_rev', sender.userId);
    await insertSend('snd_attg', sender.userId, ['outside@gmail.com'], { status: 'failed', external_state: 'attempting', attachmentIds: ['att_rev'] });
    await env.DB.prepare(`UPDATE send_queue SET last_error = 'external_uncertain' WHERE id = 'snd_attg'`).run();
    // review 列引用中 → 守門擋下刪除
    const del = await apiCall('/attachments/att_rev', sender.cookies, env, { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect(await env.DB.prepare(`SELECT 1 FROM attachments WHERE id = 'att_rev'`).first()).toBeTruthy();
  });

  it('狀態機[Fix-2 discard 清理]：純外部 review 帶附件 → discard 清除 staged 附件；已綁定者不誤刪', async () => {
    const sender = await seedUser(env, 'attd@miseroda.com');
    // (a) 未綁定 staged 附件 → discard 後清除
    await insertAttachment('att_dis', sender.userId);
    await insertSend('snd_attd', sender.userId, ['outside@gmail.com'], { status: 'failed', external_state: 'attempting', attachmentIds: ['att_dis'] });
    await env.DB.prepare(`UPDATE send_queue SET last_error = 'external_uncertain' WHERE id = 'snd_attd'`).run();
    expect((await apiCall('/send/snd_attd/resolve', sender.cookies, env, { body: { decision: 'discard' } })).status).toBe(200);
    expect(await env.DB.prepare(`SELECT 1 FROM attachments WHERE id = 'att_dis'`).first()).toBeNull(); // 不留孤兒
    expect(await env.MAIL_STORE.get(`upload/${sender.userId}/att_dis`)).toBeNull(); // R2 也清

    // (b) 已綁定（message_id 非 NULL）的附件 → discard 不可誤刪（否則毀真實寄件備份附件）
    await insertMessage('msg_real', sender.userId);
    await insertAttachment('att_bound', sender.userId, { messageId: 'msg_real' });
    await insertSend('snd_attd2', sender.userId, ['outside2@gmail.com'], { status: 'failed', external_state: 'attempting', attachmentIds: ['att_bound'] });
    await env.DB.prepare(`UPDATE send_queue SET last_error = 'external_uncertain' WHERE id = 'snd_attd2'`).run();
    expect((await apiCall('/send/snd_attd2/resolve', sender.cookies, env, { body: { decision: 'discard' } })).status).toBe(200);
    expect(await env.DB.prepare(`SELECT 1 FROM attachments WHERE id = 'att_bound'`).first()).toBeTruthy(); // 守門保留
  });

  it('狀態機[Fix-3 綁定閂鎖]：寄送不會奪走別封信已綁定的附件（不 re-parent）', async () => {
    const sender = await seedUser(env, 'attl@miseroda.com');
    const { calls, envSend } = stubSendEnv();
    await insertMessage('msg_other', sender.userId);
    await insertAttachment('att_latch', sender.userId, { messageId: 'msg_other' }); // 已綁到別封訊息
    await insertSend('snd_attl', sender.userId, ['outside@gmail.com'], { attachmentIds: ['att_latch'] });
    await runSend('snd_attl', envSend);
    expect(calls).toHaveLength(1);
    const mid = (await env.DB.prepare(`SELECT message_id FROM attachments WHERE id = 'att_latch'`).first<{ message_id: string }>())?.message_id;
    expect(mid).toBe('msg_other'); // 閂鎖：未被奪走、不 re-parent
    expect((await env.DB.prepare(`SELECT status FROM send_queue WHERE id = 'snd_attl'`).first<{ status: string }>())?.status).toBe('sent');
  });

  it('狀態機[Fix CLONE 衝突複製]：兩封共用同一 staged 附件 → 第二封 Sent 副本獲得自有可下載附件（旗標誠實且檔案在）', async () => {
    const sender = await seedUser(env, 'dq@miseroda.com');
    const { calls, envSend } = stubSendEnv();
    await insertAttachment('att_dq', sender.userId); // message_id NULL
    await insertSend('snd_dqa', sender.userId, ['outside@gmail.com'], { attachmentIds: ['att_dq'] });
    await insertSend('snd_dqb', sender.userId, ['outside2@gmail.com'], { attachmentIds: ['att_dq'] });

    await runSend('snd_dqa', envSend); // 先綁定 att_dq → msgA（閂鎖贏家）
    await runSend('snd_dqb', envSend); // att_dq 已被搶 → 為 msgB 複製一份自有副本

    expect(calls).toHaveLength(2); // 兩封都正確投遞（附件投遞前已自 R2 緩衝）

    const aMid = (await env.DB.prepare(`SELECT message_id FROM send_queue WHERE id = 'snd_dqa'`).first<{ message_id: string }>())?.message_id;
    expect((await env.DB.prepare(`SELECT has_attachments FROM messages WHERE id = ?`).bind(aMid).first<{ has_attachments: number }>())?.has_attachments).toBe(1);
    // 原 staged 列仍綁在第一封（閂鎖未被奪走）
    expect((await env.DB.prepare(`SELECT message_id FROM attachments WHERE id = 'att_dq'`).first<{ message_id: string }>())?.message_id).toBe(aMid);

    // 第二封：旗標誠實為 1，且有自己的附件列（非共用 att_dq、r2_key 為複製的自有 key、R2 物件存在 → 可下載）
    const bMid = (await env.DB.prepare(`SELECT message_id FROM send_queue WHERE id = 'snd_dqb'`).first<{ message_id: string }>())?.message_id;
    expect((await env.DB.prepare(`SELECT has_attachments FROM messages WHERE id = ?`).bind(bMid).first<{ has_attachments: number }>())?.has_attachments).toBe(1);
    const bAtt = await env.DB.prepare(`SELECT id, r2_key, filename FROM attachments WHERE message_id = ?`).bind(bMid).first<{ id: string; r2_key: string; filename: string }>();
    expect(bAtt).toBeTruthy();
    expect(bAtt!.id).not.toBe('att_dq'); // 自有新列，非共用 staged 列
    expect(bAtt!.filename).toBe('f.bin');
    expect(bAtt!.r2_key).not.toBe(`upload/${sender.userId}/att_dq`); // 自有 key，非共用 staged R2 物件
    expect(await env.MAIL_STORE.head(bAtt!.r2_key)).toBeTruthy(); // 複製的 R2 物件存在 → 可下載（head 不取 body）
  });

  it('狀態機：暫時拒收(E_RATE_LIMIT_EXCEEDED 確定未接受) → 回滾 NULL + 還原 scheduled 自動重試', async () => {
    const sender = await seedUser(env, 'smtr@miseroda.com');
    const { calls, envSend } = stubSendEnv('transient');
    await insertSend('snd_tr', sender.userId, ['outside@gmail.com']);
    const res = await runSend('snd_tr', envSend);

    expect(calls).toHaveLength(1);
    expect(res.retryMessages.length).toBe(1); // 丟回 queue 自動重試
    const row = await env.DB.prepare(`SELECT status, external_state FROM send_queue WHERE id = 'snd_tr'`).first<{ status: string; external_state: string | null }>();
    expect(row?.status).toBe('scheduled');
    expect(row?.external_state).toBeNull(); // 確定未接受 → 回滾 → 重試乾淨重送
  });

  it('狀態機[F1相容]：升級殘留列(external_sent_at 有值、external_state NULL) → 視為已接受、跳過外送', async () => {
    const sender = await seedUser(env, 'smcompat@miseroda.com');
    const { calls, envSend } = stubSendEnv();
    // 模擬 0007 之前舊碼留下的列：外送已成功(external_sent_at 有值) 但 external_state 尚未回填
    await insertSend('snd_compat', sender.userId, ['outside@gmail.com'], { external_sent_at: Date.now() });
    await runSend('snd_compat', envSend);

    expect(calls).toHaveLength(0); // 相容守門：external_sent_at 有值 → 不重送外部
    const st = (await env.DB.prepare(`SELECT status FROM send_queue WHERE id = 'snd_compat'`).first<{ status: string }>())?.status;
    expect(st).toBe('sent'); // 只補本地收尾
  });

  it('狀態機[F1相容]：0008 backfill 把 external_sent_at 有值的列補標 accepted', async () => {
    const sender = await seedUser(env, 'smbf@miseroda.com');
    await insertSend('snd_bf1', sender.userId, ['outside@gmail.com'], { external_sent_at: Date.now(), external_state: null });
    await insertSend('snd_bf2', sender.userId, ['outside@gmail.com'], { external_sent_at: null, external_state: null });
    // 重跑 0008 的回填語句（冪等）
    await env.DB.prepare(`UPDATE send_queue SET external_state = 'accepted' WHERE external_sent_at IS NOT NULL AND external_state IS NULL`).run();
    const bf1 = (await env.DB.prepare(`SELECT external_state FROM send_queue WHERE id = 'snd_bf1'`).first<{ external_state: string | null }>())?.external_state;
    const bf2 = (await env.DB.prepare(`SELECT external_state FROM send_queue WHERE id = 'snd_bf2'`).first<{ external_state: string | null }>())?.external_state;
    expect(bf1).toBe('accepted'); // 有送過 → 補標
    expect(bf2).toBeNull(); // 沒送過 → 不動
  });

  it('狀態機：happy path → external_state=accepted、status=sent、外送一次', async () => {
    const sender = await seedUser(env, 'sm4@miseroda.com');
    const { calls, envSend } = stubSendEnv();
    await insertSend('snd_sm4', sender.userId, ['outside@gmail.com']);
    await runSend('snd_sm4', envSend);

    expect(calls).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status, external_state, external_sent_at FROM send_queue WHERE id = 'snd_sm4'`).first<{ status: string; external_state: string; external_sent_at: number | null }>();
    expect(row?.status).toBe('sent');
    expect(row?.external_state).toBe('accepted');
    expect(row?.external_sent_at).toBeTruthy();
  });

  it('狀態機：sweep 卡住的 attempting → 待裁決、無外送 → 一般失敗', async () => {
    const sender = await seedUser(env, 'sm6@miseroda.com');
    const old = Date.now() - 20 * 60_000; // 20 分鐘前，超過 15 分鐘門檻
    await env.DB.prepare(
      `INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at, external_state) VALUES
        ('snd_sm6a', ?, '{}', 'sending', ?, ?, 'attempting'),
        ('snd_sm6b', ?, '{}', 'sending', ?, ?, NULL)`,
    )
      .bind(sender.userId, old, old, sender.userId, old, old)
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: '* * * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);

    const a = await env.DB.prepare(`SELECT status, last_error FROM send_queue WHERE id = 'snd_sm6a'`).first<{ status: string; last_error: string }>();
    expect(a?.status).toBe('failed');
    expect(a?.last_error).toBe('external_uncertain'); // 待裁決
    const b = await env.DB.prepare(`SELECT status, last_error FROM send_queue WHERE id = 'snd_sm6b'`).first<{ status: string; last_error: string }>();
    expect(b?.status).toBe('failed');
    expect(b?.last_error).toContain('stuck in sending'); // 一般失敗（可重寄）
  });

  it('狀態機：/resolve resend 重新外送、sent 跳過外送只收尾；一般 retry 拒絕待裁決列', async () => {
    const sender = await seedUser(env, 'sm5@miseroda.com');
    await seedUser(env, 'sm5r@miseroda.com');
    const { calls, envSend } = stubSendEnv();

    // 待裁決列 A：resend
    await insertSend('snd_sm5a', sender.userId, ['outside@gmail.com'], { status: 'failed', external_state: 'attempting' });
    // 一般 retry 應拒絕（409）
    const retryRes = await apiCall('/send/snd_sm5a/retry', sender.cookies, env, { body: {} });
    expect(retryRes.status).toBe(409);
    // resolve resend → 重新外送
    expect((await apiCall('/send/snd_sm5a/resolve', sender.cookies, env, { body: { decision: 'resend' } })).status).toBe(200);
    let row = await env.DB.prepare(`SELECT status, external_state FROM send_queue WHERE id = 'snd_sm5a'`).first<{ status: string; external_state: string | null }>();
    expect(row?.status).toBe('scheduled');
    expect(row?.external_state).toBeNull();
    await runSend('snd_sm5a', envSend);
    expect(calls).toHaveLength(1); // 確實重送

    // 待裁決列 B：sent（確認已送達）→ 跳過外送只收尾
    await insertSend('snd_sm5b', sender.userId, ['sm5r@miseroda.com', 'outside@gmail.com'], { status: 'failed', external_state: 'attempting' });
    expect((await apiCall('/send/snd_sm5b/resolve', sender.cookies, env, { body: { decision: 'sent' } })).status).toBe(200);
    row = await env.DB.prepare(`SELECT status, external_state FROM send_queue WHERE id = 'snd_sm5b'`).first<{ status: string; external_state: string | null }>();
    expect(row?.external_state).toBe('accepted');
    await runSend('snd_sm5b', envSend);
    expect(calls).toHaveLength(1); // 沒有再外送（仍是 1）
    const st = (await env.DB.prepare(`SELECT status FROM send_queue WHERE id = 'snd_sm5b'`).first<{ status: string }>())?.status;
    expect(st).toBe('sent');
  });

  it('狀態機：/resolve sent 補蓋 external_sent_at（維持 accepted ⟹ external_sent_at 有值 不變式）', async () => {
    const sender = await seedUser(env, 'smsent@miseroda.com');
    await insertSend('snd_sent', sender.userId, ['outside@gmail.com'], { status: 'failed', external_state: 'attempting', external_sent_at: null });
    expect((await apiCall('/send/snd_sent/resolve', sender.cookies, env, { body: { decision: 'sent' } })).status).toBe(200);
    const row = await env.DB.prepare(`SELECT external_state, external_sent_at FROM send_queue WHERE id = 'snd_sent'`).first<{ external_state: string; external_sent_at: number | null }>();
    expect(row?.external_state).toBe('accepted');
    expect(row?.external_sent_at).toBeTruthy(); // 補蓋，兩個事實來源不分歧
  });

  it('狀態機：/resolve discard → 終態 canceled、離開 outbox、不外送、一般 retry 仍被擋', async () => {
    const sender = await seedUser(env, 'smdis@miseroda.com');
    const { calls, envSend } = stubSendEnv();
    await insertSend('snd_dis', sender.userId, ['outside@gmail.com'], { status: 'failed', external_state: 'attempting' });
    expect((await apiCall('/send/snd_dis/resolve', sender.cookies, env, { body: { decision: 'discard' } })).status).toBe(200);

    const row = await env.DB.prepare(`SELECT status, last_error, external_state FROM send_queue WHERE id = 'snd_dis'`).first<{ status: string; last_error: string; external_state: string }>();
    expect(row?.status).toBe('canceled'); // 終態
    expect(row?.last_error).toBe('discarded');
    expect(row?.external_state).toBe('attempting'); // 保留作縱深防禦

    // 已離開 outbox（outbox 只查 scheduled/sending/failed）
    const outbox = await (await apiCall('/outbox', sender.cookies, env)).json<{ items: { id: string }[] }>();
    expect(outbox.items.find((o) => o.id === 'snd_dis')).toBeUndefined();

    // 一般 /retry 仍被擋（canceled 非 failed）；即使硬跑 consumer 也不外送（status 非 scheduled）
    expect((await apiCall('/send/snd_dis/retry', sender.cookies, env, { body: {} })).status).toBe(409);
    await runSend('snd_dis', envSend);
    expect(calls).toHaveLength(0);
  });

  it('E2：被排程中寄送引用的 staged 附件不可刪（409，關掉 TOCTOU）', async () => {
    const sender = await seedUser(env, 'e2@miseroda.com');
    await seedUser(env, 'e2r@miseroda.com');
    const { envSend } = stubSendEnv();

    const form = new FormData();
    form.set('file', new File([new Uint8Array([7, 7, 7])], 'inv.pdf', { type: 'application/pdf' }));
    const up = await (await apiCall('/attachments/upload', sender.cookies, envSend, { form })).json<{ id: string }>();

    // 排入寄送（含 undo 窗口，故停在 scheduled）
    await apiCall('/messages/send', sender.cookies, envSend, {
      body: { to: ['e2r@miseroda.com'], subject: '發票', text: '附上', attachmentIds: [up.id], undoWindowSec: 30 },
    });

    // 被引用 → 刪除被擋
    const del = await apiCall(`/attachments/${up.id}`, sender.cookies, envSend, { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect((await del.json<{ error: string }>()).error).toBe('attachment_in_use');
    // 附件仍在
    const still = await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE id = ?`).bind(up.id).first<{ n: number }>();
    expect(still?.n).toBe(1);
  });

  it('D3：重寄重跑規則不覆蓋收件人已手動搬移的資料夾', async () => {
    const sender = await seedUser(env, 'd3@miseroda.com');
    const recipient = await seedUser(env, 'd3r@miseroda.com');
    const { envSend } = stubSendEnv();

    // 收件人有條 move 規則：來自 d3@ → 歸檔
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at)
       VALUES (?, ?, '歸檔', ?, ?, 1, 0, ?)`,
    )
      .bind('rule_d3', recipient.userId, JSON.stringify({ fromContains: 'd3@miseroda.com' }), JSON.stringify({ moveToFolder: 'archive' }), Date.now())
      .run();

    const send = await apiCall('/messages/send', sender.cookies, envSend, {
      body: { to: ['d3r@miseroda.com'], subject: '報告', text: 'hi', undoWindowSec: 0 },
    });
    const sendId = (await send.json<{ id: string }>()).id;
    await runSend(sendId, envSend);

    const msg = await env.DB.prepare(`SELECT id, folder FROM messages WHERE user_id = ?`).bind(recipient.userId).first<{ id: string; folder: string }>();
    expect(msg?.folder).toBe('archive'); // 規則首次生效

    // 收件人手動把它丟到垃圾桶
    await env.DB.prepare(`UPDATE messages SET folder = 'trash' WHERE id = ?`).bind(msg!.id).run();

    // 使用者重寄（重跑收尾步驟）
    await env.DB.prepare(`UPDATE send_queue SET status = 'scheduled', message_id = NULL WHERE id = ?`).bind(sendId).run();
    await runSend(sendId, envSend);

    // 規則不應以寫死的 inbox 重新歸檔，覆蓋收件人的 trash
    const after = (await env.DB.prepare(`SELECT folder FROM messages WHERE id = ?`).bind(msg!.id).first<{ folder: string }>())?.folder;
    expect(after).toBe('trash');
  });
});
