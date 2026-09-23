// 收信 pipeline 整合測試：email() → R2/D1 → ingest consumer（消毒/FTS/規則）→ 信箱 API
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { makeSnippet } from '../../src/worker/email/ingest';
import { r2HtmlKey, r2RawKey } from '../../src/worker/lib/keys';
import {
  attachmentEmail,
  calendarInviteEmail,
  htmlStyleEmail,
  htmlXssEmail,
  mockEmailMessage,
  plainEmail,
  seedUser,
  spamEmail,
} from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

// 測試雷區（CLAUDE.md／LESSONS L5）：真 env 的 INGEST_QUEUE 會在背景自動投遞 consumer（與手動 batch 競速、跨 it 殘留）；
// 真 env 的 AI 會連到 Cloudflare 帳號真跑 Workers AI（計費，且每次 0.6～2s 網路延遲——e2e 曾因此逼近 5s 逾時）。
// deliver 擋自動投遞；consumer 換 AI stub：{} → 收據卡清洗為 null、備稿為空，等同「AI 沒抽到」的正常路徑。
const quietEnv = { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
const noAiEnv = { ...env, AI: { run: async () => ({ response: {} }) } } as unknown as typeof env;

async function deliver(raw: string, opts: { from?: string; to?: string } = {}) {
  const ctx = createExecutionContext();
  const { message, result } = mockEmailMessage(raw, opts);
  await worker.email(message, quietEnv, ctx);
  return result;
}

/** 取最新 ingest 訊息 id 並跑 consumer（模擬 queue 投遞） */
async function runIngestConsumer(messageId: string, userId: string) {
  const batch = createMessageBatch('miseroda-ingest', [
    { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'ingest', messageId, userId }, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, noAiEnv, ctx);
  const result = await getQueueResult(batch, ctx);
  expect(result.retryMessages).toHaveLength(0);
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
  const ctx = createExecutionContext();
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    ctx,
  );
}

async function latestMessageId(userId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: string }>();
  return row!.id;
}

// F4.2b：帶 text/plain 附件（內含可搜尋字）的信
function textAttachEmail(to: string, secretWord: string): string {
  const b = 'TXTBND42';
  return [
    'From: sender@ext.com', `To: ${to}`, 'Subject: report attached', 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', 'See attached report.',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Disposition: attachment; filename="report.txt"', '',
    `Quarterly figures ${secretWord} confidential`,
    `--${b}--`,
  ].join('\r\n');
}

describe('ingest pipeline', () => {
  it('F4.2b：text/plain 附件內文進 FTS → 可被搜尋', async () => {
    const u = await seedUser(env, 'ftsatt@miseroda.com');
    await deliver(textAttachEmail('ftsatt@miseroda.com', 'ZEBRAQUOLL12'), { from: 'sender@ext.com', to: 'ftsatt@miseroda.com' });
    const mid = await latestMessageId(u.userId);
    await runIngestConsumer(mid, u.userId);
    const data = await (await apiCall(`/messages?q=ZEBRAQUOLL12`, u.cookies)).json<{ items: { id: string }[] }>();
    expect(data.items.some((m) => m.id === mid)).toBe(true); // 附件內的字搜得到
  });

  it('end-to-end: deliver → parse → sanitize → FTS → mailbox API', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');

    /* ---- 未知收件人：拒收 ---- */
    const unknown = await deliver(plainEmail({ to: 'ghost@miseroda.com' }), { to: 'ghost@miseroda.com' });
    expect(unknown.rejected).toContain('No such recipient');

    /* ---- 純文字信（中文主旨 encoded-word + plus-addressing） ---- */
    const plain = await deliver(
      plainEmail({ subject: '帳單通知', body: '您的 5 月帳單已產生，金額 NT$699。', to: 'hon+bills@miseroda.com' }),
      { to: 'hon+bills@miseroda.com' },
    );
    expect(plain.rejected).toBeNull();
    const plainId = await latestMessageId(hon.userId);
    const plainRow = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?`).bind(plainId).first<{
      subject: string;
      folder: string;
      snippet: string;
      user_id: string;
    }>();
    expect(plainRow!.subject).toBe('帳單通知');
    expect(plainRow!.folder).toBe('inbox');
    expect(plainRow!.snippet).toContain('NT$699');
    expect(plainRow!.user_id).toBe(hon.userId); // plus-addressing 歸戶
    // 存在性檢查用 head()：get() 不消費 body 會讓 isolated storage 留下開啟的 handle
    expect(await env.MAIL_STORE.head(r2RawKey(hon.userId, plainId))).not.toBeNull();

    await runIngestConsumer(plainId, hon.userId);
    const htmlObj = await env.MAIL_STORE.get(r2HtmlKey(hon.userId, plainId));
    expect(htmlObj).not.toBeNull();
    expect(await htmlObj!.text()).toContain('NT$699');

    // FTS 中文子字串可查（trigram 需 ≥3 字元；1–2 字查詢由 M4 的主庫 LIKE fallback 處理）
    const ftsQuery = (q: string) =>
      env.DB_FTS.prepare(
        `SELECT m.message_id FROM messages_fts f JOIN msg_map m ON m.fts_rowid = f.rowid
         WHERE messages_fts MATCH ? AND m.user_id = ?`,
      )
        .bind(q, hon.userId)
        .all<{ message_id: string }>();
    const hit3 = await ftsQuery('帳單已產生');
    expect(hit3.results.map((r) => r.message_id)).toContain(plainId);
    const hit2 = await ftsQuery('帳單');
    expect(hit2.results).toHaveLength(0); // documents the trigram 3-char floor

    /* ---- XSS HTML 信：消毒 ---- */
    await deliver(htmlXssEmail());
    const xssId = await latestMessageId(hon.userId);
    await runIngestConsumer(xssId, hon.userId);
    const sanitized = await (await env.MAIL_STORE.get(r2HtmlKey(hon.userId, xssId)))!.text();
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('onerror');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).not.toContain('<iframe');
    expect(sanitized).not.toContain('<form');
    expect(sanitized).not.toContain('<style');
    expect(sanitized).toContain('<b>bold</b>');
    expect(sanitized).toContain('https://example.com/ok');
    expect(sanitized).toContain('rel="noopener noreferrer"');
    // 遠端圖片被改寫成點擊載入
    expect(sanitized).not.toMatch(/\ssrc="https:\/\/tracker/);
    expect(sanitized).toContain('data-blocked-src="https://tracker.example.com/pixel.png"');
    const xssRow = await env.DB.prepare(`SELECT remote_images FROM messages WHERE id = ?`)
      .bind(xssId)
      .first<{ remote_images: number }>();
    expect(xssRow!.remote_images).toBe(1);

    /* ---- 收信渲染雙修：from_addr 取 From 標頭（非信封 VERP）+ inline style 安全白名單 ---- */
    // 信封寄件者用 provider VERP 退信位址，From 標頭是 system@abao-massage.miseroda.com（兩者不同）
    await deliver(htmlStyleEmail(), { from: '0100abc-d54-43d9-000000@send.abao-massage.miseroda.com' });
    const styleId = await latestMessageId(hon.userId);
    // Bug2：顯示用寄件者取自 From 標頭，而非信封 VERP 退信位址
    const styleRow = await env.DB.prepare(`SELECT from_addr, from_name FROM messages WHERE id = ?`)
      .bind(styleId)
      .first<{ from_addr: string; from_name: string }>();
    expect(styleRow!.from_addr).toBe('system@abao-massage.miseroda.com');
    expect(styleRow!.from_name).toBe('葆健室');
    // Bug1：消毒後保留安全 inline style（尺寸/排版），剔除覆蓋類與遠端背景圖
    await runIngestConsumer(styleId, hon.userId);
    const styleSan = await (await env.MAIL_STORE.get(r2HtmlKey(hon.userId, styleId)))!.text();
    expect(styleSan).toContain('width:120px'); // 圖片尺寸保留 → 不再退回 max-width:100% 撐爆
    expect(styleSan).toContain('text-align:center'); // 排版保留
    expect(styleSan).not.toContain('position'); // 覆蓋類（position/top）剔除
    expect(styleSan).not.toContain('url('); // 遠端背景圖（追蹤）整條丟棄

    /* ---- 行事曆會議邀請（.ics）→ 解析成邀請卡 + 不算一般附件 + 可下載 ---- */
    await deliver(calendarInviteEmail());
    const calId = await latestMessageId(hon.userId);
    const calRow = await env.DB.prepare(`SELECT calendar_event, has_attachments FROM messages WHERE id = ?`)
      .bind(calId)
      .first<{ calendar_event: string | null; has_attachments: number }>();
    expect(calRow!.calendar_event).toBeTruthy();
    const ev = JSON.parse(calRow!.calendar_event!) as { summary: string; location: string; method: string; startMs: number };
    expect(ev.summary).toBe('季度會議');
    expect(ev.location).toBe('會議室 A');
    expect(ev.method).toBe('REQUEST');
    expect(ev.startMs).toBe(Date.UTC(2026, 5, 20, 6, 0, 0));
    expect(calRow!.has_attachments).toBe(0); // .ics 不列為一般附件
    const icsRes = await apiCall(`/messages/${calId}/calendar.ics`, hon.cookies);
    expect(icsRes.status).toBe(200);
    expect(icsRes.headers.get('Content-Type')).toContain('text/calendar');
    expect(await icsRes.text()).toContain('BEGIN:VEVENT');

    /* ---- 維護端點 /admin/messages/resanitize：既有信 backfill（修 from_addr + 重消毒）---- */
    // 模擬舊信壞狀態：from_addr 被存成信封 VERP 退信位址
    await env.DB.prepare(`UPDATE messages SET from_addr = ? WHERE id = ?`)
      .bind('0100xyz-000000@send.abao-massage.miseroda.com', styleId)
      .run();
    const resan = await apiCall('/admin/messages/resanitize', hon.cookies, { method: 'POST', body: {} });
    expect(resan.status).toBe(200);
    const resanBody = await resan.json<{ fixedFrom: number; resanitized: number }>();
    expect(resanBody.fixedFrom).toBeGreaterThanOrEqual(1);
    // from_addr 重解析回 From 標頭（非信封 VERP）
    const fixedRow = await env.DB.prepare(`SELECT from_addr FROM messages WHERE id = ?`)
      .bind(styleId)
      .first<{ from_addr: string }>();
    expect(fixedRow!.from_addr).toBe('system@abao-massage.miseroda.com');
    // HTML 重消毒後保留安全 inline style
    const reHtml = await (await env.MAIL_STORE.get(r2HtmlKey(hon.userId, styleId)))!.text();
    expect(reHtml).toContain('width:120px');

    /* ---- 附件信 ---- */
    await deliver(attachmentEmail());
    const attMsgId = await latestMessageId(hon.userId);
    const atts = await env.DB.prepare(`SELECT * FROM attachments WHERE message_id = ?`)
      .bind(attMsgId)
      .all<{ id: string; filename: string; r2_key: string }>();
    expect(atts.results).toHaveLength(1);
    expect(atts.results[0].filename).toBe('itinerary.pdf');
    expect(await env.MAIL_STORE.head(atts.results[0].r2_key)).not.toBeNull();

    /* ---- 對話串：In-Reply-To 串接 ---- */
    await deliver(plainEmail({ subject: '專案討論', messageId: '<thread-root@example.com>' }));
    const rootId = await latestMessageId(hon.userId);
    await deliver(
      plainEmail({
        subject: 'Re: 專案討論',
        inReplyTo: '<thread-root@example.com>',
        references: '<thread-root@example.com>',
      }),
    );
    const replyId = await latestMessageId(hon.userId);
    const [rootRow, replyRow] = await Promise.all([
      env.DB.prepare(`SELECT thread_id FROM messages WHERE id = ?`).bind(rootId).first<{ thread_id: string }>(),
      env.DB.prepare(`SELECT thread_id FROM messages WHERE id = ?`).bind(replyId).first<{ thread_id: string }>(),
    ]);
    expect(replyRow!.thread_id).toBe(rootRow!.thread_id);
    const threadRow = await env.DB.prepare(`SELECT message_count, subject FROM threads WHERE id = ?`)
      .bind(rootRow!.thread_id)
      .first<{ message_count: number; subject: string }>();
    expect(threadRow!.message_count).toBe(2);
    expect(threadRow!.subject).toBe('專案討論');

    /* ---- SPF/DKIM/DMARC 全敗 → 垃圾信 ---- */
    await deliver(spamEmail(), { from: 'winner@crypto-scam.example' });
    const spamId = await latestMessageId(hon.userId);
    const spamRow = await env.DB.prepare(`SELECT folder FROM messages WHERE id = ?`)
      .bind(spamId)
      .first<{ folder: string }>();
    expect(spamRow!.folder).toBe('spam');

    /* ---- 規則引擎：寄件者含關鍵字 → 加標籤 + 星標 ---- */
    const labelId = 'lbl_test1';
    await env.DB.prepare(`INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, '帳單', '#FBD46D', ?)`)
      .bind(labelId, hon.userId, Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at)
       VALUES ('rul_t1', ?, '帳單自動歸檔', ?, ?, 1, 0, ?)`,
    )
      .bind(
        hon.userId,
        JSON.stringify({ fromContains: 'ebill@' }),
        JSON.stringify({ addLabelId: labelId, star: true }),
        Date.now(),
      )
      .run();
    await deliver(plainEmail({ from: 'ebill@taiwanmobile.com', subject: '電子帳單' }), {
      from: 'ebill@taiwanmobile.com',
    });
    const billId = await latestMessageId(hon.userId);
    await runIngestConsumer(billId, hon.userId);
    const billRow = await env.DB.prepare(`SELECT is_starred FROM messages WHERE id = ?`)
      .bind(billId)
      .first<{ is_starred: number }>();
    expect(billRow!.is_starred).toBe(1);
    const billLabels = await env.DB.prepare(`SELECT label_id FROM message_labels WHERE message_id = ?`)
      .bind(billId)
      .all<{ label_id: string }>();
    expect(billLabels.results.map((r) => r.label_id)).toContain(labelId);

    /* ---- 信箱 API ---- */
    const countsRes = await apiCall('/mailbox/counts', hon.cookies);
    expect(countsRes.status).toBe(200);
    const counts = await countsRes.json<{
      folders: Record<string, { total: number; unread: number }>;
      labels: { id: string; count: number }[];
    }>();
    expect(counts.folders.inbox.total).toBeGreaterThanOrEqual(5);
    expect(counts.folders.inbox.unread).toBeGreaterThanOrEqual(5);
    expect(counts.folders.spam.total).toBe(1);
    expect(counts.labels.find((l) => l.id === labelId)?.count).toBe(1);

    const listRes = await apiCall('/messages?folder=inbox', hon.cookies);
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ items: { id: string; subject: string; labels: string[] }[] }>();
    expect(list.items.length).toBeGreaterThanOrEqual(5);
    expect(list.items.find((i) => i.id === billId)?.labels).toContain(labelId);

    // LIKE 搜尋（M2 基本版）
    const searchRes = await apiCall('/messages?folder=inbox&q=%E5%B0%88%E6%A1%88', hon.cookies); // 專案
    const search = await searchRes.json<{ items: { id: string }[] }>();
    expect(search.items.map((i) => i.id)).toContain(rootId);

    // 對話串閱讀
    const detailRes = await apiCall(`/messages/${replyId}`, hon.cookies);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json<{ thread: { id: string; html: string }[] }>();
    expect(detail.thread).toHaveLength(2);

    // 標記已讀 + 星標 + 封存
    const patchRes = await apiCall(`/messages/${plainId}`, hon.cookies, {
      method: 'PATCH',
      body: { unread: false, starred: true },
    });
    expect(patchRes.status).toBe(200);
    const archiveRes = await apiCall(`/messages/${plainId}`, hon.cookies, {
      method: 'PATCH',
      body: { folder: 'archive' },
    });
    expect(archiveRes.status).toBe(200);
    const archivedRow = await env.DB.prepare(`SELECT folder, is_read, is_starred FROM messages WHERE id = ?`)
      .bind(plainId)
      .first<{ folder: string; is_read: number; is_starred: number }>();
    expect(archivedRow).toMatchObject({ folder: 'archive', is_read: 1, is_starred: 1 });

    /* ---- 附件下載 + 跨使用者隔離 ---- */
    const attId = atts.results[0].id;
    const dlRes = await apiCall(`/attachments/${attId}`, hon.cookies);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('Content-Disposition')).toContain('attachment');
    // 必須消費 R2-backed stream，否則 isolated storage 在 suite 結束時會留下開啟的 handle
    expect((await dlRes.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const crossRes = await apiCall(`/attachments/${attId}`, kai.cookies);
    expect(crossRes.status).toBe(404);
    await crossRes.arrayBuffer();
    const crossMsg = await apiCall(`/messages/${plainId}`, kai.cookies);
    expect(crossMsg.status).toBe(404);
    const kaiList = await apiCall('/messages?folder=inbox', kai.cookies);
    const kaiItems = await kaiList.json<{ items: unknown[] }>();
    expect(kaiItems.items).toHaveLength(0);

    /* ---- 超大信件拒收 ---- */
    const big = mockEmailMessage(plainEmail({}), {});
    Object.defineProperty(big.message, 'rawSize', { value: 26 * 1024 * 1024 });
    const ctx = createExecutionContext();
    await worker.email(big.message, env, ctx);
    expect(big.result.rejected).toContain('too large');
  });

  it('dual-delivery: FORWARD_TO forwards known and unknown recipients', async () => {
    await seedUser(env, 'hon@miseroda.com', 'admin');
    const envForward = { ...env, FORWARD_TO: 'legacy@gmail.com' } as unknown as typeof env;

    const known = mockEmailMessage(plainEmail({}), { to: 'hon@miseroda.com' });
    await worker.email(known.message, envForward, createExecutionContext());
    expect(known.result.rejected).toBeNull();
    expect(known.result.forwarded).toContain('legacy@gmail.com');

    const unknown = mockEmailMessage(plainEmail({ to: 'ghost@miseroda.com' }), { to: 'ghost@miseroda.com' });
    await worker.email(unknown.message, envForward, createExecutionContext());
    expect(unknown.result.rejected).toBeNull();
    expect(unknown.result.forwarded).toContain('legacy@gmail.com');
  });

  it('List-Unsubscribe 標頭 → 一鍵退訂資料存入', async () => {
    const u = await seedUser(env, 'unsub@miseroda.com');
    await deliver(
      plainEmail({
        to: 'unsub@miseroda.com',
        subject: '電子報',
        extraHeaders: [
          'List-Unsubscribe: <https://news.example/u?id=9>, <mailto:x@news.example>',
          'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        ],
      }),
      { to: 'unsub@miseroda.com' },
    );
    const id = await latestMessageId(u.userId);
    const row = await env.DB.prepare(`SELECT list_unsubscribe FROM messages WHERE id = ?`)
      .bind(id)
      .first<{ list_unsubscribe: string | null }>();
    expect(row!.list_unsubscribe).toBeTruthy();
    const parsed = JSON.parse(row!.list_unsubscribe!) as { httpUrl: string; oneClick: boolean };
    expect(parsed.httpUrl).toBe('https://news.example/u?id=9');
    expect(parsed.oneClick).toBe(true);
  });
});

// F2.8b：真實 consumer 端到端——已退訂寄件者再寄 → 自動歸檔（驗 ordering/throw-safe/gating 不只 SQL）
describe('F2.8b 已退訂仍寄送自動歸檔（consumer 端到端）', () => {
  it('已退訂寄件者 → consumer 歸檔 + unsub_resend=1', async () => {
    const u = await seedUser(env, 'u8b@miseroda.com');
    await env.DB.prepare(`INSERT OR IGNORE INTO unsubscribed_senders (user_id, sender, created_at) VALUES (?, 'spammer@news.io', 0)`).bind(u.userId).run();
    await deliver(plainEmail({ from: 'spammer@news.io', to: 'u8b@miseroda.com', subject: '又來推銷' }), { from: 'spammer@news.io', to: 'u8b@miseroda.com' });
    const mid = await latestMessageId(u.userId);
    await runIngestConsumer(mid, u.userId);
    const row = await env.DB.prepare(`SELECT folder, unsub_resend FROM messages WHERE id = ?`).bind(mid).first<{ folder: string; unsub_resend: number }>();
    expect(row).toMatchObject({ folder: 'archive', unsub_resend: 1 });
  });

  it('未退訂寄件者 → 留收件匣（不誤觸）', async () => {
    const u = await seedUser(env, 'u8c@miseroda.com');
    await deliver(plainEmail({ from: 'ok@friend.io', to: 'u8c@miseroda.com', subject: '哈囉' }), { from: 'ok@friend.io', to: 'u8c@miseroda.com' });
    const mid = await latestMessageId(u.userId);
    await runIngestConsumer(mid, u.userId);
    expect((await env.DB.prepare(`SELECT folder, unsub_resend FROM messages WHERE id = ?`).bind(mid).first<{ folder: string; unsub_resend: number }>())).toMatchObject({ folder: 'inbox', unsub_resend: 0 });
  });
});

// makeSnippet：去標籤改成線性單次前掃（原 /<[^>]+>/g 對惡意 HTML 會二次方回溯）
describe('makeSnippet', () => {
  it('一般信件的 snippet 與舊 regex 寫法逐字元相同', () => {
    expect(makeSnippet('您的 5 月帳單已產生，金額 NT$699。', '<p>ignored</p>')).toBe('您的 5 月帳單已產生，金額 NT$699。');
    expect(makeSnippet('  多行\n  文字  ', undefined)).toBe('多行 文字');
    expect(makeSnippet('   ', '<p>Hello <b>world</b></p>')).toBe('Hello world'); // 空白 text → 退回 HTML
    expect(makeSnippet(undefined, '<p>  leading   spaces  </p>')).toBe('leading spaces');
    expect(makeSnippet(undefined, '<style>.a{color:red}</style>正文')).toBe('.a{color:red} 正文');
    expect(makeSnippet(undefined, undefined)).toBe('');
    // 原 regex 的邊界語意保留：'<>' 不算標籤（[^>]+ 至少一字元）、屬性內的 '>' 提早收尾、'<' 無對應 '>' 原樣保留
    expect(makeSnippet(undefined, 'a<>b')).toBe('a<>b');
    expect(makeSnippet(undefined, '<a title="a>b">x</a>')).toBe('b">x');
    expect(makeSnippet(undefined, '未關閉的 < 角括號')).toBe('未關閉的 < 角括號');
    // 140 字截斷
    expect(makeSnippet(undefined, `<p>${'ab'.repeat(200)}</p>`)).toBe('ab'.repeat(70));
  });

  it('全是 < 的惡意 HTML 不會二次方回溯（舊寫法在此輸入要跑數十秒）', () => {
    const evil = '<'.repeat(200_000);
    expect(makeSnippet(undefined, evil)).toBe('<'.repeat(140));
    expect(makeSnippet('', `${evil}尾巴文字`)).toBe('<'.repeat(140));
  });

  it('巨量標籤但無文字的 HTML 也只掃一次（不累積輸出）', () => {
    expect(makeSnippet(undefined, '<a>'.repeat(300_000))).toBe('');
    expect(makeSnippet(undefined, `${'<a>'.repeat(300_000)}末尾文字`)).toBe('末尾文字');
  });
});
