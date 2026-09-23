// F7.6：MBOX 匯入消費者。切 mbox → 逐封 postal-mime 解析 → 寫 D1+FTS（仿 deliverInternal，
// folder=archive、已讀、dedup）。分批處理（DB next_offset 冪等推進）避 CPU/記憶體上限 + queue retry 不重複計數/重排。
import PostalMime from 'postal-mime';
import { htmlToText, sanitizeEmailHtml, textToHtml } from '../email/sanitize';
import { bumpThread, resolveThread } from '../email/threading';
import { r2HtmlKey } from '../lib/keys';
import { newId } from '../lib/ids';
import type { ImportMboxJob } from './types';

const FTS_BODY_CAP = 100_000;
const BATCH = 30; // 每批處理幾封（控單次 invocation 的 CPU/記憶體）

interface ImportRow {
  id: string;
  user_id: string;
  r2_key: string;
  status: string;
  total: number;
  next_offset: number;
}

/**
 * 切 mbox：以「信封 From_ 行」分隔。用嚴格 regex（From + 寄件者 + 星期幾）避免 mboxo（未跳脫）
 * 內文出現「From …」行被誤切成兩封。mboxrd 內文 >From 於切後 unescape 還原。
 */
export function splitMbox(text: string): string[] {
  return text
    .split(/^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) .*$/m)
    .map((s) => s.replace(/^>(>*From )/gm, '$1').trim()) // mboxrd unescape：>From→From、>>From→>From…
    .filter((s) => s.length > 0);
}

async function sha256short(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function processImportJob(env: Env, job: ImportMboxJob): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, r2_key, status, total, next_offset FROM import_jobs WHERE id = ? AND user_id = ?`,
  )
    .bind(job.jobId, job.userId)
    .first<ImportRow>();
  if (!row || row.status === 'done' || row.status === 'error') return; // 已結束/不存在 → no-op

  const obj = await env.MAIL_STORE.get(row.r2_key);
  if (!obj) {
    await env.DB.prepare(`UPDATE import_jobs SET status='error', error='mbox 已不存在', updated_at=? WHERE id=?`)
      .bind(Date.now(), job.jobId)
      .run();
    return;
  }
  const blocks = splitMbox(await obj.text());
  const total = blocks.length;

  // 空檔/非 mbox/無有效信 → 標 error，別假裝成功（done with 0）
  if (total === 0) {
    await env.DB.prepare(`UPDATE import_jobs SET status='error', error='檔案為空或非有效 mbox 格式', total=0, updated_at=? WHERE id=?`)
      .bind(Date.now(), job.jobId)
      .run();
    try {
      await env.MAIL_STORE.delete(row.r2_key);
    } catch {
      /* ignore */
    }
    return;
  }

  // DB next_offset 是「下一批起點」的唯一真相（不信 queue 訊息的 offset）。
  const offset = row.next_offset;
  if (offset >= total) {
    await env.DB.prepare(`UPDATE import_jobs SET status='done', total=?, updated_at=? WHERE id=? AND status != 'done'`)
      .bind(total, Date.now(), job.jobId)
      .run();
    try {
      await env.MAIL_STORE.delete(row.r2_key);
    } catch {
      /* ignore */
    }
    return;
  }
  if (row.status === 'pending') {
    await env.DB.prepare(`UPDATE import_jobs SET total=?, status='running', updated_at=? WHERE id=?`)
      .bind(total, Date.now(), job.jobId)
      .run();
  }

  const userEmail =
    (await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(job.userId).first<{ email: string }>())?.email?.toLowerCase() ?? '';

  let done = 0;
  let skipped = 0;
  let failed = 0;
  const end = Math.min(offset + BATCH, total);
  for (let i = offset; i < end; i++) {
    const r = await importOne(env, job.userId, userEmail, blocks[i], job.jobId);
    if (r === 'ok') done++;
    else if (r === 'dup') skipped++;
    else failed++;
  }

  // 條件式推進：WHERE next_offset = offset → 只有「從這個 offset 出發」的那一次能成功。
  // queue retry / fan-out 重複訊息讀到已推進的 next_offset → changes=0 → 不重複計數、不重複 re-enqueue（收斂）。
  const finished = end >= total;
  const upd = await env.DB.prepare(
    `UPDATE import_jobs SET done=done+?, skipped=skipped+?, failed=failed+?, next_offset=?, status=?, updated_at=?
     WHERE id=? AND next_offset=?`,
  )
    .bind(done, skipped, failed, end, finished ? 'done' : 'running', Date.now(), job.jobId, offset)
    .run();

  if ((upd.meta.changes ?? 0) > 0) {
    if (finished) {
      try {
        await env.MAIL_STORE.delete(row.r2_key); // 匯完清掉上傳的 mbox，省 R2
      } catch {
        /* ignore */
      }
    } else {
      await env.INGEST_QUEUE.send({ kind: 'import-mbox', jobId: job.jobId, userId: job.userId, offset: end });
    }
  }
}

async function importOne(env: Env, userId: string, userEmail: string, raw: string, importJobId: string): Promise<'ok' | 'dup' | 'fail'> {
  try {
    const parsed = await PostalMime.parse(raw);
    const fromAddr = (parsed.from?.address ?? '').toLowerCase();
    const subject = parsed.subject || '(無主旨)';
    const parsedTs = parsed.date ? Date.parse(parsed.date) : NaN;
    const timestamp = Number.isFinite(parsedTs) ? parsedTs : Date.now();
    // dedup 鍵：有真 Message-ID 用之；否則用「內容雜湊」當穩定鍵 → 重匯同一份 mbox 不會變新 id 而重複插入。
    const messageIdHeader =
      parsed.messageId ?? `<import-${await sha256short(`${fromAddr}|${timestamp}|${subject}|${raw.length}`)}@miseroda.local>`;
    const dup = await env.DB.prepare(`SELECT 1 FROM messages WHERE user_id = ? AND message_id_header = ?`)
      .bind(userId, messageIdHeader)
      .first();
    if (dup) return 'dup';

    const messageId = newId('msg');
    const fromName = parsed.from?.name || fromAddr || '(未知寄件者)';
    const toAddrs = (parsed.to ?? []).map((a) => a.address ?? '').filter(Boolean);
    const ccAddrs = (parsed.cc ?? []).map((a) => a.address ?? '').filter(Boolean);
    const direction = fromAddr && fromAddr === userEmail ? 'outbound' : 'inbound';
    const threadId = await resolveThread(env, userId, {
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
      subject,
      timestamp,
    });

    const sourceHtml = parsed.html ?? textToHtml(parsed.text ?? '');
    const { html } = await sanitizeEmailHtml(sourceHtml, new Map()); // remote_images 不設 → 預設封鎖（安全）
    const bodyText = parsed.text?.trim() ? parsed.text : await htmlToText(html);
    const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 140);
    const htmlKey = r2HtmlKey(userId, messageId);
    await env.MAIL_STORE.put(htmlKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });

    // 仿 deliverInternal 的 messages INSERT。MVP：不匯附件→has_attachments=0；一律 is_read=1 / folder=archive（待議：保留原資料夾）。
    // F9.2：帶 import_job_id 標記——匯入史是刻意的永久檔案庫，封存保留規則永不清它。
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, message_id_header, in_reply_to, references_header,
        direction, from_addr, from_name, to_addrs, cc_addrs, subject, snippet, r2_html_key,
        size_bytes, has_attachments, is_read, folder, import_job_id, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'archive', ?, ?, ?)`,
    )
      .bind(
        messageId,
        userId,
        threadId,
        messageIdHeader,
        parsed.inReplyTo ?? null,
        parsed.references ?? null,
        direction,
        fromAddr,
        fromName,
        JSON.stringify(toAddrs),
        JSON.stringify(ccAddrs),
        subject,
        snippet,
        htmlKey,
        new TextEncoder().encode(bodyText).byteLength,
        importJobId,
        timestamp,
        Date.now(),
      )
      .run();
    await bumpThread(env, threadId, timestamp);

    // FTS 索引（第二顆 D1）：msg_map 取 rowid → INSERT OR REPLACE messages_fts
    const ftsBody = bodyText.slice(0, FTS_BODY_CAP);
    await env.DB_FTS.prepare(`INSERT OR IGNORE INTO msg_map (message_id, user_id) VALUES (?, ?)`).bind(messageId, userId).run();
    const mapRow = await env.DB_FTS.prepare(`SELECT fts_rowid FROM msg_map WHERE message_id = ?`)
      .bind(messageId)
      .first<{ fts_rowid: number }>();
    if (mapRow) {
      await env.DB_FTS.prepare(
        `INSERT OR REPLACE INTO messages_fts (rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(mapRow.fts_rowid, subject, `${fromName} ${fromAddr}`, snippet, ftsBody)
        .run();
    }
    return 'ok';
  } catch (e) {
    console.error('import message failed', e); // best-effort：壞掉的單封跳過、不阻斷整批
    return 'fail';
  }
}
