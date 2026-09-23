// F9.1：spam/trash 30 天自動清 —— 30 天邊界 / NULL 防禦 / R2 級聯 / 使用者開關 / trigger 起算。
// 依 CLAUDE.md 慣例：每個斷言主題獨立小 it()（isolatedStorage 每個 it 回滾）。
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { seedUser } from './helpers/fixtures';
import { sweep } from '../../src/worker/jobs/sweep';
import { purgeMessages } from '../../src/worker/lib/purge';
import { r2AttKey, r2HtmlKey, r2RawKey } from '../../src/worker/lib/keys';

const DAY = 86400_000;

function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
}

let seq = 0;
/** 插入一封信；trigger 會把 folder_changed_at 落為 now，之後可用 folderChangedAt 回填模擬時間流逝。 */
async function insertMsg(
  userId: string,
  args: {
    folder?: string; folderChangedAt?: number; starred?: boolean; pinned?: boolean; listUnsub?: boolean;
    unread?: boolean; snoozedUntil?: number; status?: string; importJobId?: string; threadId?: string; direction?: string;
  } = {},
): Promise<string> {
  seq += 1;
  const id = `pm${seq}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, subject, snippet, folder, is_read,
                           is_starred, pinned_at, list_unsubscribe, snoozed_until, message_status, import_job_id,
                           r2_raw_key, r2_html_key, received_at, created_at)
     VALUES (?, ?, ?, ?, 'a@x.com', 's', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, args.threadId ?? `t-${id}`, args.direction ?? 'inbound', args.folder ?? 'trash',
      args.unread ? 0 : 1, args.starred ? 1 : 0, args.pinned ? now : null,
      args.listUnsub ? '<mailto:u@x.com>' : null, args.snoozedUntil ?? null, args.status ?? null,
      args.importJobId ?? null, r2RawKey(userId, id), r2HtmlKey(userId, id), now, now)
    .run();
  if (args.folderChangedAt !== undefined) {
    // 直接改 folder_changed_at 不會觸發 UPDATE OF folder trigger → 可安全回填測試時間
    await env.DB.prepare(`UPDATE messages SET folder_changed_at = ? WHERE id = ?`).bind(args.folderChangedAt, id).run();
  }
  return id;
}

async function msgExists(id: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 FROM messages WHERE id = ?`).bind(id).first());
}

describe('F9.1 spam/trash 30 天自動清', () => {
  it('30 天邊界：31 天前的 trash/spam 被清，29 天前的留下', async () => {
    const u = await seedUser(env, 'p1@miseroda.com');
    const old1 = await insertMsg(u.userId, { folder: 'trash', folderChangedAt: Date.now() - 31 * DAY });
    const old2 = await insertMsg(u.userId, { folder: 'spam', folderChangedAt: Date.now() - 31 * DAY });
    const fresh = await insertMsg(u.userId, { folder: 'trash', folderChangedAt: Date.now() - 29 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(old1)).toBe(false);
    expect(await msgExists(old2)).toBe(false);
    expect(await msgExists(fresh)).toBe(true);
  });

  it('R2（raw/html/附件）與 attachments/message_labels 列一併級聯清除', async () => {
    const u = await seedUser(env, 'p2@miseroda.com');
    const id = await insertMsg(u.userId, { folder: 'trash', folderChangedAt: Date.now() - 40 * DAY });
    const attKey = r2AttKey(u.userId, id, 'att1');
    await env.MAIL_STORE.put(r2RawKey(u.userId, id), 'raw');
    await env.MAIL_STORE.put(r2HtmlKey(u.userId, id), '<p>hi</p>');
    await env.MAIL_STORE.put(attKey, 'bin');
    await env.DB.prepare(
      `INSERT INTO attachments (id, user_id, message_id, filename, mime_type, size_bytes, r2_key, created_at)
       VALUES ('att1', ?, ?, 'f.bin', 'application/octet-stream', 3, ?, ?)`,
    ).bind(u.userId, id, attKey, Date.now()).run();
    await env.DB.prepare(`INSERT INTO labels (id, user_id, name, created_at) VALUES ('lblx', ?, 'L', ?)`)
      .bind(u.userId, Date.now())
      .run();
    await env.DB.prepare(`INSERT INTO message_labels (message_id, label_id) VALUES (?, 'lblx')`).bind(id).run();

    await sweep(quietEnv());

    expect(await msgExists(id)).toBe(false);
    // R2 存在性檢查用 .head()（.get() 未消化 body 會卡 isolatedStorage）
    expect(await env.MAIL_STORE.head(r2RawKey(u.userId, id))).toBeNull();
    expect(await env.MAIL_STORE.head(r2HtmlKey(u.userId, id))).toBeNull();
    expect(await env.MAIL_STORE.head(attKey)).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 FROM attachments WHERE message_id = ?`).bind(id).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 FROM message_labels WHERE message_id = ?`).bind(id).first()).toBeNull();
  });

  it('folder_changed_at NULL 永不清（防禦邊界，理論上 migration 已 backfill）', async () => {
    const u = await seedUser(env, 'p3@miseroda.com');
    const id = await insertMsg(u.userId, { folder: 'trash' });
    await env.DB.prepare(`UPDATE messages SET folder_changed_at = NULL WHERE id = ?`).bind(id).run();
    await sweep(quietEnv());
    expect(await msgExists(id)).toBe(true);
  });

  it('使用者關閉開關（prefs.purgeSpamTrash=false）→ 不清；其他使用者不受影響', async () => {
    const off = await seedUser(env, 'p4@miseroda.com');
    const on = await seedUser(env, 'p5@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"purgeSpamTrash":false}', ?)`,
    ).bind(off.userId, Date.now()).run();
    const keep = await insertMsg(off.userId, { folder: 'trash', folderChangedAt: Date.now() - 60 * DAY });
    const gone = await insertMsg(on.userId, { folder: 'trash', folderChangedAt: Date.now() - 60 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(keep)).toBe(true);
    expect(await msgExists(gone)).toBe(false);
  });

  it('防禦：pref 存成字串 "false"（API 已拒收，但若既存）→ 視為關閉、不清（安全方向）', async () => {
    const u = await seedUser(env, 'p10@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"purgeSpamTrash":"false"}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const id = await insertMsg(u.userId, { folder: 'trash', folderChangedAt: Date.now() - 60 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(id)).toBe(true);
  });

  it('其他資料夾永不清：inbox/archive 舊信不受影響', async () => {
    const u = await seedUser(env, 'p6@miseroda.com');
    const inbox = await insertMsg(u.userId, { folder: 'inbox', folderChangedAt: Date.now() - 400 * DAY });
    const arch = await insertMsg(u.userId, { folder: 'archive', folderChangedAt: Date.now() - 400 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(inbox)).toBe(true);
    expect(await msgExists(arch)).toBe(true);
  });

  it('race 防護：目標已被救回（folder 不在 spam/trash）→ purgeMessages 一根汗毛都不動', async () => {
    const u = await seedUser(env, 'p8@miseroda.com');
    // 模擬「sweep SELECT 撈到後、刪除前，使用者把信移回 inbox」：直接以救回後狀態呼叫 purgeMessages
    const id = await insertMsg(u.userId, { folder: 'inbox', folderChangedAt: Date.now() - 60 * DAY });
    await env.MAIL_STORE.put(r2HtmlKey(u.userId, id), '<p>rescued</p>');
    const n = await purgeMessages(env, [{ id, user_id: u.userId }], Date.now() - 30 * DAY);
    expect(n).toBe(0);
    expect(await msgExists(id)).toBe(true);
    expect(await env.MAIL_STORE.head(r2HtmlKey(u.userId, id))).not.toBeNull(); // R2 內容未被毀
  });

  it('race 防護：folder_changed_at 已為 NULL（他 cron 認領中）→ 跳過不重複刪', async () => {
    const u = await seedUser(env, 'p9@miseroda.com');
    const id = await insertMsg(u.userId, { folder: 'trash' });
    await env.DB.prepare(`UPDATE messages SET folder_changed_at = NULL WHERE id = ?`).bind(id).run();
    const n = await purgeMessages(env, [{ id, user_id: u.userId }], Date.now() + DAY);
    expect(n).toBe(0);
    expect(await msgExists(id)).toBe(true);
  });

  it('F9.2 archive 保留：設 90 天 → 91 天前的清、89 天前的留；未設定者永久保留', async () => {
    const ua = await seedUser(env, 'r1@miseroda.com');
    const ub = await seedUser(env, 'r2@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"retention":{"archive":90}}', ?)`,
    ).bind(ua.userId, Date.now()).run();
    const gone = await insertMsg(ua.userId, { folder: 'archive', folderChangedAt: Date.now() - 91 * DAY });
    const keep = await insertMsg(ua.userId, { folder: 'archive', folderChangedAt: Date.now() - 89 * DAY });
    const noCfg = await insertMsg(ub.userId, { folder: 'archive', folderChangedAt: Date.now() - 400 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(gone)).toBe(false);
    expect(await msgExists(keep)).toBe(true);
    expect(await msgExists(noCfg)).toBe(true);
  });

  it('F9.2 電子報保留：只清帶 List-Unsubscribe 的信；一般收件匣信同齡不動', async () => {
    const u = await seedUser(env, 'r3@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"retention":{"newsletter":90}}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const news = await insertMsg(u.userId, { folder: 'inbox', listUnsub: true, folderChangedAt: Date.now() - 100 * DAY });
    const plain = await insertMsg(u.userId, { folder: 'inbox', folderChangedAt: Date.now() - 100 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(news)).toBe(false);
    expect(await msgExists(plain)).toBe(true);
  });

  it('F9.2 星標/釘選永不清（含電子報）', async () => {
    const u = await seedUser(env, 'r4@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"retention":{"archive":30,"newsletter":30}}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const starred = await insertMsg(u.userId, { folder: 'archive', starred: true, folderChangedAt: Date.now() - 200 * DAY });
    const pinned = await insertMsg(u.userId, { folder: 'archive', pinned: true, folderChangedAt: Date.now() - 200 * DAY });
    const starNews = await insertMsg(u.userId, { folder: 'inbox', listUnsub: true, starred: true, folderChangedAt: Date.now() - 200 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(starred)).toBe(true);
    expect(await msgExists(pinned)).toBe(true);
    expect(await msgExists(starNews)).toBe(true);
  });

  it('F9.2 使用者訊號豁免：稍後處理中 / 工作流狀態 / 待跟進的信永不清', async () => {
    const u = await seedUser(env, 'r7@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"retention":{"archive":30,"newsletter":30}}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const snoozed = await insertMsg(u.userId, { folder: 'inbox', listUnsub: true, snoozedUntil: Date.now() + 5 * DAY, folderChangedAt: Date.now() - 100 * DAY });
    const waiting = await insertMsg(u.userId, { folder: 'archive', status: 'waiting', folderChangedAt: Date.now() - 100 * DAY });
    const followed = await insertMsg(u.userId, { folder: 'archive', folderChangedAt: Date.now() - 100 * DAY });
    await env.DB.prepare(
      `INSERT INTO follow_ups (id, user_id, thread_id, message_id, subject, due_at, await_reply, ref_at, status, created_at)
       VALUES ('fu1', ?, ?, ?, 's', ?, 0, ?, 'pending', ?)`,
    ).bind(u.userId, `t-${followed}`, followed, Date.now() + 30 * DAY, Date.now(), Date.now()).run();
    await sweep(quietEnv());
    expect(await msgExists(snoozed)).toBe(true);
    expect(await msgExists(waiting)).toBe(true);
    expect(await msgExists(followed)).toBe(true);
  });

  it('F9.2 匯入史豁免：import_job_id 標記的封存信不受保留期影響', async () => {
    const u = await seedUser(env, 'r8@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"retention":{"archive":30}}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const imported = await insertMsg(u.userId, { folder: 'archive', importJobId: 'job1', folderChangedAt: Date.now() - 400 * DAY });
    const normal = await insertMsg(u.userId, { folder: 'archive', folderChangedAt: Date.now() - 400 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(imported)).toBe(true);
    expect(await msgExists(normal)).toBe(false);
  });

  it('F9.2 電子報窄化：未讀不清；使用者回覆過的串不清', async () => {
    const u = await seedUser(env, 'r9@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"retention":{"newsletter":30}}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const unread = await insertMsg(u.userId, { folder: 'inbox', listUnsub: true, unread: true, folderChangedAt: Date.now() - 100 * DAY });
    const replied = await insertMsg(u.userId, { folder: 'inbox', listUnsub: true, threadId: 'th-conv', folderChangedAt: Date.now() - 100 * DAY });
    await insertMsg(u.userId, { folder: 'sent', direction: 'outbound', threadId: 'th-conv' }); // 使用者回覆過
    const plainNews = await insertMsg(u.userId, { folder: 'inbox', listUnsub: true, folderChangedAt: Date.now() - 100 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(unread)).toBe(true);
    expect(await msgExists(replied)).toBe(true);
    expect(await msgExists(plainNews)).toBe(false);
  });

  it('F9.2 防呆：髒 retention 值（<30 的正數/字串）不觸發清理', async () => {
    const u = await seedUser(env, 'r5@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{"retention":{"archive":7,"newsletter":"90"}}', ?)`,
    ).bind(u.userId, Date.now()).run();
    const arch = await insertMsg(u.userId, { folder: 'archive', folderChangedAt: Date.now() - 20 * DAY });
    const news = await insertMsg(u.userId, { folder: 'inbox', listUnsub: true, folderChangedAt: Date.now() - 400 * DAY });
    await sweep(quietEnv());
    expect(await msgExists(arch)).toBe(true); // 7 天檔位不存在 → 不清
    expect(await msgExists(news)).toBe(true); // 字串 "90" 非數字 → 不清
  });

  it('purgeMessages 資料夾白名單：非法資料夾直接 throw（防未來誤用）', async () => {
    const u = await seedUser(env, 'r6@miseroda.com');
    const id = await insertMsg(u.userId, { folder: 'trash' });
    await expect(purgeMessages(env, [{ id, user_id: u.userId }], Date.now(), { folders: ['sent'] })).rejects.toThrow();
  });

  it('trigger：INSERT 自動落 folder_changed_at≈now；搬資料夾重置起算（舊信丟垃圾桶從當下重算）', async () => {
    const u = await seedUser(env, 'p7@miseroda.com');
    const before = Date.now();
    const id = await insertMsg(u.userId, { folder: 'inbox' });
    const row1 = await env.DB.prepare(`SELECT folder_changed_at AS v FROM messages WHERE id = ?`).bind(id).first<{ v: number | null }>();
    // unixepoch 秒級精度 → 容差 2s
    expect(row1?.v).not.toBeNull();
    expect(row1!.v!).toBeGreaterThanOrEqual(before - 2000);

    // 回填成很久以前，再搬到 trash → 應重置為 now（絕不追溯用舊時間清）
    await env.DB.prepare(`UPDATE messages SET folder_changed_at = ? WHERE id = ?`).bind(Date.now() - 365 * DAY, id).run();
    const beforeMove = Date.now();
    await env.DB.prepare(`UPDATE messages SET folder = 'trash' WHERE id = ?`).bind(id).run();
    const row2 = await env.DB.prepare(`SELECT folder_changed_at AS v FROM messages WHERE id = ?`).bind(id).first<{ v: number | null }>();
    expect(row2!.v!).toBeGreaterThanOrEqual(beforeMove - 2000);
    // 剛丟進垃圾桶的舊信不會被本次 sweep 清掉
    await sweep(quietEnv());
    expect(await msgExists(id)).toBe(true);
  });
});
