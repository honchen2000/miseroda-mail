// 信箱 API：資料夾計數、訊息列表（keyset 分頁）、對話串閱讀、星標/封存/搬移、附件 proxy
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type Vars } from './middleware';
import { r2CalKey, r2UploadKey } from '../lib/keys';
import { mboxFromLine, mboxrdQuote } from '../lib/mbox';
import { isPublicHttpsUrl, postOneClickUnsubscribe } from '../email/list-unsubscribe';
import { markQuotedHtml } from '../email/quoteMark';
import { icsCacheKey, type IcsCache } from '../jobs/icsSync';
import { notifyUser } from '../lib/notify';
import { randomToken, sha256Hex } from '../lib/crypto';
import { birthdayOccurrences, parseBirthday } from '../lib/birthdays';
import { buildReply, buildRequest, type Partstat } from '../email/calendar';
import { INBOX_CATEGORIES, type InboxCategory } from '../email/categorize';
import { deleteCalendarEvent, dismissCalendarFlags, setEventRsvp, upsertCalendarEvent } from '../email/calendarStore';
import { computeReminderNextMs, expandOccurrences, parseRrule } from '../email/rrule';
import { trainFromFolderChange, type TrainableMsg } from '../email/spamTrain';
import { newId } from '../lib/ids';
import { EDGE_CACHE_TTL, edgeCacheKey, edgeCacheMatch, edgeCachePut, edgeCachedText } from '../lib/edgeCache';
import { buildAgenda, taipeiDayWindow } from '../lib/agenda';
import { rateLimitMw } from '../lib/ratelimit';
import { isScriptableImageType } from './settings';
import type { SendPayload } from './send';
import type { SendJob } from '../jobs/types';

const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'] as const;
type Folder = (typeof FOLDERS)[number];

// 收據 lane 的主旨關鍵字（保守集合，降低誤判；固定值、無使用者輸入故免 LIKE 跳脫）。
// F10.3 起與 ingest 端的卡片抽取共用同一來源，避免兩份清單漂移。
import { RECEIPT_KEYWORDS } from '../lib/receiptCard';

interface MsgListRow {
  id: string;
  thread_id: string;
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  received_at: number;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  label_ids: string | null;
  message_status: string | null;
  pinned_at: number | null;
  snoozed_until: number | null;
  subject_override: string | null;
  receipt_card: string | null;
}

// 把 pipe 分隔的值（a|b|c）建成跨指定欄位的 OR-LIKE 子句（同一運算子內 = 或）；上限 8 段避免濫用。
// 轉義 LIKE 萬用字元 % _ \ 並帶 ESCAPE（同 /files 端點慣例），否則 subject:50% / from:a_b 會變成萬用比對。
function pipeOrLike(cols: string[], value: string, binds: unknown[]): string | null {
  const parts = value.split('|').map((v) => v.trim()).filter(Boolean).slice(0, 8);
  if (!parts.length) return null;
  const ors: string[] = [];
  for (const p of parts) {
    const esc = p.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    for (const col of cols) {
      ors.push(`${col} LIKE ? ESCAPE '\\'`);
      binds.push(`%${esc}%`);
    }
  }
  return `(${ors.join(' OR ')})`;
}

function listItem(r: MsgListRow) {
  return {
    id: r.id,
    threadId: r.thread_id,
    from: { name: r.from_name || r.from_addr, addr: r.from_addr },
    subject: r.subject,
    snippet: r.snippet,
    ts: r.received_at,
    unread: !r.is_read,
    starred: !!r.is_starred,
    hasAttachments: !!r.has_attachments,
    labels: r.label_ids ? r.label_ids.split(',') : [],
    status: (r.message_status as 'needs_reply' | 'waiting' | null) ?? null,
    pinned: r.pinned_at != null,
    snoozedUntil: r.snoozed_until ?? null, // F8.10：供前端辨識「剛從稍後浮回」的信，給時鐘微動畫
    subjectOverride: r.subject_override ?? null, // F9.7：顯示用主旨改寫（僅前端呈現層使用）
    // F10.3：帳單/包裹卡（ingest AI 抽取，已清洗；解析失敗視為無卡）
    receiptCard: r.receipt_card ? (() => { try { return JSON.parse(r.receipt_card as string) as Record<string, unknown>; } catch { return null; } })() : null,
  };
}

export function mailRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use('*', requireSession);
  // RSVP / 自建會議邀請會發真實外送信 → 比照 /messages/send 上限流（保護 Email Sending 額度與網域信譽）
  app.use('/messages/:id/rsvp', rateLimitMw('rsvp', 10, 60));
  app.use('/calendar/invite', rateLimitMw('invite', 10, 60));

  /* ---------- 側欄計數 ---------- */
  app.get('/mailbox/counts', async (c) => {
    const userId = c.var.user.id;
    const now = Date.now();
    // 效能：9 支查詢原本各自 .all()/.first() 包在 Promise.all 裡 → 9 個並發 D1 HTTP 往返；
    // 彼此互不相依、綁定值也都已知 → 改用 db.batch() 一次送出 → 1 趟 D1 往返。
    // batch() 回傳「依序」的 D1Result 陣列，每個元素是 {results, meta}；原本用 .first<T>() 的地方
    // 這裡一律改抓 results[0]——這幾支都是無 GROUP BY 的 COUNT(*)/SUM(...) 聚合，SQL 語意上恆回 1
    // 列（COUNT 空表為 0、SUM 空表為 NULL），results[0] 與原本 .first() 的行為完全等價。
    const [foldersRes, starredRes, labelsRes, draftsRes, snoozedRes, followupsRes, inboxCatsRes, workflowRes, lanesRes] =
      await c.var.db.batch([
        // 收件匣計數排除「稍後處理」中的信（NULL-safe：避免三值邏輯把整個收件匣排除）
        c.var.db.prepare(
          `SELECT folder, COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
           FROM messages
           WHERE user_id = ? AND NOT (folder = 'inbox' AND snoozed_until IS NOT NULL AND snoozed_until > ?)
             AND NOT (folder = 'inbox' AND screening = 1)
           GROUP BY folder`,
        ).bind(userId, now),
        c.var.db.prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND is_starred = 1 AND folder != 'trash'`,
        ).bind(userId),
        c.var.db.prepare(
          // F4.5：帶 parent_id/sort_order，依 sort_order→created_at 排序（常用置頂；側欄遞迴渲染用）。
          `SELECT l.id, l.name, l.color, l.parent_id, l.sort_order,
                  (SELECT COUNT(*) FROM message_labels ml JOIN messages m ON m.id = ml.message_id
                   WHERE ml.label_id = l.id AND m.folder NOT IN ('trash','spam')) AS count
           FROM labels l WHERE l.user_id = ? ORDER BY l.sort_order, l.created_at`,
        ).bind(userId),
        c.var.db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE user_id = ?`).bind(userId),
        c.var.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND snoozed_until > ?`).bind(userId, now),
        c.var.db.prepare(`SELECT COUNT(*) AS n FROM follow_ups WHERE user_id = ? AND status IN ('pending','fired')`).bind(
          userId,
        ),
        // 收件匣分類分頁計數（排除稍後處理中的信；NULL 視為 primary）
        c.var.db.prepare(
          `SELECT COALESCE(category, 'primary') AS cat, COUNT(*) AS total,
                  SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
           FROM messages
           WHERE user_id = ? AND folder = 'inbox' AND screening = 0 AND NOT (snoozed_until IS NOT NULL AND snoozed_until > ?)
           GROUP BY COALESCE(category, 'primary')`,
        ).bind(userId, now),
        // 工作流通道計數（跨資料夾、排除垃圾桶）
        c.var.db.prepare(
          `SELECT SUM(CASE WHEN message_status = 'needs_reply' THEN 1 ELSE 0 END) AS needs_reply,
                  SUM(CASE WHEN message_status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
                  SUM(CASE WHEN pinned_at IS NOT NULL THEN 1 ELSE 0 END) AS pinned
           FROM messages WHERE user_id = ? AND folder != 'trash'`,
        ).bind(userId),
        // 分流 lane 計數（電子報 = 有 List-Unsubscribe；收據 = 主旨關鍵字）；跨資料夾排除垃圾桶/垃圾信
        c.var.db.prepare(
          `SELECT SUM(CASE WHEN list_unsubscribe IS NOT NULL AND screening = 0 THEN 1 ELSE 0 END) AS newsletter,
                  SUM(CASE WHEN (${RECEIPT_KEYWORDS.map(() => 'subject LIKE ?').join(' OR ')}) AND screening = 0 THEN 1 ELSE 0 END) AS receipt,
                  SUM(CASE WHEN folder = 'inbox' AND screening = 1 THEN 1 ELSE 0 END) AS screening
           FROM messages WHERE user_id = ? AND folder NOT IN ('trash','spam')`,
        ).bind(...RECEIPT_KEYWORDS.map((k) => `%${k}%`), userId),
      ]);

    // D1 讀取複本觀測：batch() 回傳的 D1Result 本來就帶 meta，直接讀第一支結果即可，
    // 不需要在 middleware 包一層攔截所有 prepare()。取不到就完全不設標頭（本機 miniflare
    // 就是這種情況），絕不 throw、絕不設成 "undefined/undefined"。
    // 用途：確認 read_replication 開啟後 GET 是否真的被複本服務；問題釐清後可整段移除。
    const { served_by_region, served_by_primary } = foldersRes.meta;
    if (served_by_region !== undefined || served_by_primary !== undefined) {
      const primaryLabel = served_by_primary === undefined ? 'unknown' : served_by_primary ? 'primary' : 'replica';
      c.header('X-D1-Region', `${served_by_region ?? 'unknown'}/${primaryLabel}`);
    }

    const folders = { results: foldersRes.results as { folder: Folder; total: number; unread: number }[] };
    const starred = (starredRes.results as { n: number }[])[0] as { n: number } | undefined;
    const labels = {
      results: labelsRes.results as { id: string; name: string; color: string; parent_id: string | null; sort_order: number; count: number }[],
    };
    const drafts = (draftsRes.results as { n: number }[])[0] as { n: number } | undefined;
    const snoozed = (snoozedRes.results as { n: number }[])[0] as { n: number } | undefined;
    const followupsCount = (followupsRes.results as { n: number }[])[0] as { n: number } | undefined;
    const inboxCats = { results: inboxCatsRes.results as { cat: string; total: number; unread: number }[] };
    const workflow = (workflowRes.results as { needs_reply: number; waiting: number; pinned: number }[])[0] as
      | { needs_reply: number; waiting: number; pinned: number }
      | undefined;
    const lanes = (lanesRes.results as { newsletter: number; receipt: number; screening: number }[])[0] as
      | { newsletter: number; receipt: number; screening: number }
      | undefined;

    const folderMap: Record<string, { total: number; unread: number }> = {};
    for (const f of FOLDERS) folderMap[f] = { total: 0, unread: 0 };
    for (const row of folders.results) folderMap[row.folder] = { total: row.total, unread: row.unread ?? 0 };
    folderMap['drafts'] = { total: drafts?.n ?? 0, unread: 0 };

    const catMap: Record<string, { total: number; unread: number }> = {};
    for (const cat of INBOX_CATEGORIES) catMap[cat] = { total: 0, unread: 0 };
    for (const row of inboxCats.results) catMap[row.cat] = { total: row.total, unread: row.unread ?? 0 };

    return c.json({
      folders: folderMap,
      starred: starred?.n ?? 0,
      snoozed: snoozed?.n ?? 0,
      followups: followupsCount?.n ?? 0,
      needsReply: workflow?.needs_reply ?? 0,
      waiting: workflow?.waiting ?? 0,
      pinned: workflow?.pinned ?? 0,
      newsletter: lanes?.newsletter ?? 0,
      receipt: lanes?.receipt ?? 0,
      screening: lanes?.screening ?? 0, // F5.3：待審夾數
      labels: labels.results.map((l) => ({ id: l.id, name: l.name, color: l.color, parentId: l.parent_id, sortOrder: l.sort_order, count: l.count })),
      inboxCategories: catMap,
    });
  });

  /* ---------- 訊息列表 ---------- */
  app.get('/messages', async (c) => {
    const userId = c.var.user.id;
    const q = c.req.query('q')?.trim() ?? '';
    const folder = c.req.query('folder') ?? 'inbox';
    const labelId = c.req.query('label');
    const limit = Math.max(1, Math.min(Math.trunc(Number(c.req.query('limit'))) || 50, 100)); // NaN/負數/小數/越界防護（負值會讓 SQLite 取消 LIMIT 上限）
    const cursor = c.req.query('cursor');

    const wheres: string[] = ['m.user_id = ?'];
    const binds: unknown[] = [userId];

    if (labelId) {
      wheres.push(`m.id IN (SELECT message_id FROM message_labels WHERE label_id = ?)`);
      wheres.push(`m.folder NOT IN ('trash','spam')`);
      binds.push(labelId);
    } else if (folder === 'starred') {
      wheres.push(`m.is_starred = 1`, `m.folder != 'trash'`);
    } else if (folder === 'snoozed') {
      wheres.push(`m.snoozed_until > ?`);
      binds.push(Date.now());
    } else if (folder === 'needs_reply' || folder === 'waiting') {
      // 工作流通道（跨資料夾，排除垃圾桶）
      wheres.push(`m.message_status = ?`, `m.folder != 'trash'`);
      binds.push(folder);
    } else if (folder === 'pinned') {
      wheres.push(`m.pinned_at IS NOT NULL`, `m.folder != 'trash'`);
    } else if (folder === 'newsletter') {
      // 電子報 lane：有 List-Unsubscribe 標頭的清單/批量信（F5.3：待審信不外漏到此 lane）
      wheres.push(`m.list_unsubscribe IS NOT NULL`, `m.folder NOT IN ('trash','spam')`, `m.screening = 0`);
    } else if (folder === 'receipt') {
      // 收據 lane：主旨含交易/收據關鍵字（啟發式）
      wheres.push(`(${RECEIPT_KEYWORDS.map(() => 'm.subject LIKE ?').join(' OR ')})`, `m.folder NOT IN ('trash','spam')`, `m.screening = 0`);
      binds.push(...RECEIPT_KEYWORDS.map((k) => `%${k}%`));
    } else if (folder === 'screening') {
      wheres.push(`m.folder = 'inbox'`, `m.screening = 1`); // F5.3：待審夾＝仍在 inbox 但已標 screening
    } else {
      if (!FOLDERS.includes(folder as Folder)) return c.json({ error: 'bad_folder' }, 400);
      wheres.push(`m.folder = ?`);
      binds.push(folder);
      if (folder === 'inbox') wheres.push(`m.screening = 0`); // F5.3：待審信不出現在收件匣
      // 收件匣隱藏稍後處理中的信
      if (folder === 'inbox') {
        wheres.push(`(m.snoozed_until IS NULL OR m.snoozed_until <= ?)`);
        binds.push(Date.now());
        // 分類分頁：primary 含 NULL（既有/未分類信）
        const cat = c.req.query('category');
        if (cat && INBOX_CATEGORIES.includes(cat as InboxCategory)) {
          if (cat === 'primary') wheres.push(`(m.category = 'primary' OR m.category IS NULL)`);
          else {
            wheres.push(`m.category = ?`);
            binds.push(cat);
          }
        }
      }
    }

    if (q) {
      if ([...q].length >= 3) {
        // FTS5 trigram：雙引號 phrase 查詢 = 子字串比對（中文 OK）；內文也在索引內
        const ftsQ = `"${q.replace(/"/g, '""')}"`;
        const hits = await c.env.DB_FTS.prepare(
          `SELECT m.message_id FROM messages_fts f JOIN msg_map m ON m.fts_rowid = f.rowid
           WHERE messages_fts MATCH ? AND m.user_id = ? LIMIT 200`,
        )
          .bind(ftsQ, userId)
          .all<{ message_id: string }>();
        const ids = hits.results.map((r) => r.message_id);
        if (!ids.length) return c.json({ items: [], nextCursor: null });
        wheres.push(`m.id IN (${ids.map(() => '?').join(',')})`);
        binds.push(...ids);
      } else {
        // trigram 需 ≥3 字元：1–2 字查詢 fallback 主庫 LIKE（主旨/寄件者/摘要）
        wheres.push(`(m.subject LIKE ? OR m.snippet LIKE ? OR m.from_addr LIKE ? OR m.from_name LIKE ?)`);
        const like = `%${q}%`;
        binds.push(like, like, like, like);
      }
    }

    // 搜尋運算子（from: / to: / cc: / bcc: / subject: / has:attachment / is:unread|starred / label: / before: / after:）
    // 位址/主旨類的值支援 | 表示「或」（pipeOrLike）。
    const fromOp = c.req.query('from');
    if (fromOp) {
      const cl = pipeOrLike(['m.from_addr', 'm.from_name'], fromOp, binds);
      if (cl) wheres.push(cl);
    }
    const toOp = c.req.query('to');
    if (toOp) {
      const cl = pipeOrLike(['m.to_addrs', 'm.cc_addrs'], toOp, binds);
      if (cl) wheres.push(cl);
    }
    const ccOp = c.req.query('cc');
    if (ccOp) {
      const cl = pipeOrLike(['m.cc_addrs'], ccOp, binds);
      if (cl) wheres.push(cl);
    }
    const bccOp = c.req.query('bcc');
    if (bccOp) {
      const cl = pipeOrLike(['m.bcc_addrs'], bccOp, binds);
      if (cl) wheres.push(cl);
    }
    const subjectOp = c.req.query('subject');
    if (subjectOp) {
      const cl = pipeOrLike(['m.subject'], subjectOp, binds);
      if (cl) wheres.push(cl);
    }
    if (c.req.query('hasAttachment') === '1') wheres.push(`m.has_attachments = 1`);
    if (c.req.query('isUnread') === '1') wheres.push(`m.is_read = 0`);
    if (c.req.query('isStarred') === '1') wheres.push(`m.is_starred = 1`);
    const labelName = c.req.query('labelName');
    if (labelName) {
      wheres.push(
        `m.id IN (SELECT ml.message_id FROM message_labels ml JOIN labels l ON l.id = ml.label_id
                  WHERE l.user_id = ? AND l.name = ?)`,
      );
      binds.push(userId, labelName);
    }
    const beforeOp = Number(c.req.query('before'));
    if (beforeOp > 0) {
      wheres.push(`m.received_at < ?`);
      binds.push(beforeOp);
    }
    const afterOp = Number(c.req.query('after'));
    if (afterOp > 0) {
      wheres.push(`m.received_at >= ?`);
      binds.push(afterOp);
    }
    // F4.2：larger:/smaller:（bytes，前端已換算）→ 信件大小；filename: → 附件檔名 LIKE。
    const largerOp = Number(c.req.query('larger'));
    if (largerOp > 0) {
      wheres.push(`m.size_bytes > ?`);
      binds.push(largerOp);
    }
    const smallerOp = Number(c.req.query('smaller'));
    if (smallerOp > 0) {
      wheres.push(`m.size_bytes < ?`);
      binds.push(smallerOp);
    }
    const filenameOp = c.req.query('filename');
    if (filenameOp) {
      const esc = filenameOp.replace(/[%_\\]/g, (ch) => `\\${ch}`); // 同 pipeOrLike 的 LIKE 轉義
      wheres.push(`m.id IN (SELECT message_id FROM attachments WHERE user_id = ? AND filename LIKE ? ESCAPE '\\')`);
      binds.push(userId, `%${esc}%`);
    }

    if (cursor) {
      const [ts, id] = cursor.split(':');
      wheres.push(`(m.received_at < ? OR (m.received_at = ? AND m.id < ?))`);
      binds.push(Number(ts), Number(ts), id);
    }

    const rows = await c.var.db.prepare(
      `SELECT m.id, m.thread_id, m.from_addr, m.from_name, m.subject, m.snippet, m.received_at,
              m.is_read, m.is_starred, m.has_attachments, m.message_status, m.pinned_at, m.snoozed_until, m.subject_override, m.receipt_card,
              (SELECT GROUP_CONCAT(label_id) FROM message_labels WHERE message_id = m.id) AS label_ids
       FROM messages m
       WHERE ${wheres.join(' AND ')}
       ORDER BY m.received_at DESC, m.id DESC
       LIMIT ?`,
    )
      .bind(...binds, limit + 1)
      .all<MsgListRow>();

    const items = rows.results.slice(0, limit).map(listItem);
    const nextCursor =
      rows.results.length > limit && items.length ? `${items[items.length - 1].ts}:${items[items.length - 1].id}` : null;
    return c.json({ items, nextCursor });
  });

  /* ---------- 儲存搜尋 ---------- */
  app.get('/saved-searches', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, name, query, pinned FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; name: string; query: string; pinned: number }>();
    return c.json({ searches: rows.results.map((r) => ({ ...r, pinned: !!r.pinned })) });
  });

  // F5.6a：釘/取消釘到側欄（自訂視圖分頁）
  app.patch('/saved-searches/:id', async (c) => {
    const body = z.object({ pinned: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const res = await c.var.db.prepare(`UPDATE saved_searches SET pinned = ? WHERE id = ? AND user_id = ?`)
      .bind(body.data.pinned ? 1 : 0, c.req.param('id'), c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/saved-searches', async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(80), query: z.string().trim().min(1).max(500) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const count = await c.var.db.prepare(`SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = ?`)
      .bind(c.var.user.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 50) return c.json({ error: 'limit_reached' }, 400);
    const id = newId('ss');
    // 重複（同 user 同 query）= no-op，避免連點/多分頁產生重複列（UNIQUE 索引把關）。
    await c.var.db.prepare(
      `INSERT INTO saved_searches (id, user_id, name, query, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, query) DO NOTHING`,
    )
      .bind(id, c.var.user.id, body.data.name, body.data.query, Date.now())
      .run();
    return c.json({ id });
  });

  app.delete('/saved-searches/:id', async (c) => {
    const res = await c.var.db.prepare(`DELETE FROM saved_searches WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  /* ---------- 聯絡人建議（收件者自動完成） ---------- */
  app.get('/contacts/suggest', async (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    if (!q) return c.json({ suggestions: [] });
    // 寄過的人（to_addrs JSON 展開）+ 寄信給我的人，按最近使用排序
    const rows = await c.var.db.prepare(
      `SELECT addr, MAX(ts) AS last_used FROM (
         SELECT je.value AS addr, m.received_at AS ts
           FROM messages m, json_each(m.to_addrs) je
          WHERE m.user_id = ? AND m.direction = 'outbound'
         UNION ALL
         SELECT m.from_addr AS addr, m.received_at AS ts
           FROM messages m
          WHERE m.user_id = ? AND m.direction = 'inbound' AND m.folder NOT IN ('spam','trash')
       )
       WHERE addr LIKE ? AND addr != ?
       GROUP BY addr ORDER BY last_used DESC LIMIT 8`,
    )
      .bind(c.var.user.id, c.var.user.id, `%${q}%`, c.var.user.email)
      .all<{ addr: string; last_used: number }>();
    // F2.5：多回 last_used 讓 @ 自動完成顯示「N 前聯絡過」
    return c.json({ suggestions: rows.results.map((r) => ({ addr: r.addr, lastUsed: r.last_used })) });
  });

  /* ---------- F2.6 全域跨域搜尋：信件 × 聯絡人 × 會議 × 跟進（分組、各取前 6） ----------
     信件沿用 /messages 的 FTS（≥3 字）/ LIKE（2 字）；其餘小表 LIKE。全 user_id scoped。
     AI 運算子搜尋仍走 /ai/search → /messages；此端點只負責「一搜跨四域」的概覽。 */
  app.get('/search', async (c) => {
    const userId = c.var.user.id;
    const q = (c.req.query('q') ?? '').trim();
    if ([...q].length < 2) return c.json({ q, messages: [], contacts: [], events: [], followUps: [] });
    const like = `%${q}%`;

    // 信件：≥3 字走 FTS 取候選 id，<3 字 fallback LIKE
    let msgIds: string[] = [];
    if ([...q].length >= 3) {
      const ftsQ = `"${q.replace(/"/g, '""')}"`;
      const hits = await c.env.DB_FTS.prepare(
        `SELECT m.message_id FROM messages_fts f JOIN msg_map m ON m.fts_rowid = f.rowid
         WHERE messages_fts MATCH ? AND m.user_id = ? LIMIT 50`,
      )
        .bind(ftsQ, userId)
        .all<{ message_id: string }>();
      msgIds = hits.results.map((r) => r.message_id);
    }
    const msgStmt =
      [...q].length >= 3
        ? msgIds.length
          ? c.var.db.prepare(
              `SELECT id, thread_id, subject, from_name, from_addr, received_at, folder, direction FROM messages
               WHERE user_id = ? AND folder != 'trash' AND id IN (${msgIds.map(() => '?').join(',')})
               ORDER BY received_at DESC LIMIT 6`,
            ).bind(userId, ...msgIds)
          : null
        : c.var.db.prepare(
            `SELECT id, thread_id, subject, from_name, from_addr, received_at, folder, direction FROM messages
             WHERE user_id = ? AND folder != 'trash' AND (subject LIKE ? OR from_name LIKE ? OR from_addr LIKE ?)
             ORDER BY received_at DESC LIMIT 6`,
          ).bind(userId, like, like, like);

    type MsgHit = { id: string; thread_id: string; subject: string; from_name: string; from_addr: string; received_at: number; folder: string; direction: string };
    const [msgs, contacts, events, followUps] = await Promise.all([
      msgStmt ? msgStmt.all<MsgHit>() : Promise.resolve({ results: [] as MsgHit[] }),
      // 聯絡人：往來地址 / 寄件人原名 / 自訂名 任一相符
      c.var.db.prepare(
        `SELECT agg.addr AS email, MAX(agg.name) AS known_name, MAX(agg.ts) AS last_used, MAX(ct.custom_name) AS custom_name
         FROM (
           SELECT je.value AS addr, '' AS name, m.received_at AS ts FROM messages m, json_each(m.to_addrs) je WHERE m.user_id = ? AND m.direction = 'outbound'
           UNION ALL
           SELECT m.from_addr AS addr, m.from_name AS name, m.received_at AS ts FROM messages m WHERE m.user_id = ? AND m.direction = 'inbound' AND m.folder NOT IN ('spam','trash')
         ) agg
         LEFT JOIN contacts ct ON ct.user_id = ? AND ct.email = agg.addr
         WHERE agg.addr LIKE ? OR agg.name LIKE ? OR ct.custom_name LIKE ?
         GROUP BY agg.addr ORDER BY last_used DESC LIMIT 6`,
      )
        .bind(userId, userId, userId, like, like, like)
        .all<{ email: string; known_name: string; last_used: number; custom_name: string | null }>(),
      // 會議：標題 / 地點 / 主辦人 任一相符
      c.var.db.prepare(
        `SELECT id, summary, start_ms, start_text, location, all_day, floating FROM calendar_events
         WHERE user_id = ? AND (summary LIKE ? OR location LIKE ? OR organizer LIKE ?)
         ORDER BY start_ms DESC LIMIT 6`,
      )
        .bind(userId, like, like, like)
        .all<{ id: string; summary: string; start_ms: number; start_text: string; location: string; all_day: number; floating: number }>(),
      // 跟進：主旨相符（pending 才有意義）
      c.var.db.prepare(
        `SELECT id, subject, due_at, await_reply, thread_id FROM follow_ups
         WHERE user_id = ? AND status = 'pending' AND subject LIKE ?
         ORDER BY due_at ASC LIMIT 6`,
      )
        .bind(userId, like)
        .all<{ id: string; subject: string; due_at: number; await_reply: number; thread_id: string }>(),
    ]);

    return c.json({
      q,
      messages: msgs.results.map((r) => ({
        id: r.id, threadId: r.thread_id, subject: r.subject, fromName: r.from_name, fromAddr: r.from_addr,
        receivedAt: r.received_at, folder: r.folder, direction: r.direction,
      })),
      contacts: contacts.results.map((r) => ({ email: r.email, name: r.custom_name || r.known_name || '', lastUsed: r.last_used })),
      events: events.results.map((r) => ({ id: r.id, summary: r.summary, startMs: r.start_ms, startText: r.start_text, location: r.location, allDay: !!r.all_day, floating: !!r.floating })),
      followUps: followUps.results.map((r) => ({ id: r.id, subject: r.subject, dueAt: r.due_at, awaitReply: !!r.await_reply, threadId: r.thread_id })),
    });
  });

  /* ---------- 信箱匯出（.mbox 串流：所有保存的原始 .eml） ---------- */
  app.get('/export/mbox', async (c) => {
    const userId = c.var.user.id;
    const rows = await c.var.db.prepare(
      `SELECT r2_raw_key, from_addr, received_at FROM messages
       WHERE user_id = ? AND r2_raw_key IS NOT NULL ORDER BY received_at ASC`,
    )
      .bind(userId)
      .all<{ r2_raw_key: string; from_addr: string; received_at: number }>();

    const bucket = c.env.MAIL_STORE;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const m of rows.results) {
          const obj = await bucket.get(m.r2_raw_key);
          if (!obj) continue;
          const raw = new Uint8Array(await obj.arrayBuffer());
          // F19.4：入站信的原始位元組完全由寄件者控制——內文一行 `From x@y Mon Jan  1 …`
          // 在 mbox 裡就是訊息分隔符，不跳脫等於讓任何人在受害者的備份裡偽造整封信。
          controller.enqueue(encoder.encode(mboxFromLine(m.from_addr, m.received_at)));
          controller.enqueue(mboxrdQuote(raw));
          controller.enqueue(encoder.encode('\n\n'));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/mbox',
        'Content-Disposition': `attachment; filename="miseroda-mailbox-export.mbox"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  /* ---------- 下載原始郵件 .eml ---------- */
  app.get('/messages/:id/raw', async (c) => {
    const row = await c.var.db.prepare(
      `SELECT r2_raw_key, subject FROM messages WHERE id = ? AND user_id = ?`,
    )
      .bind(c.req.param('id'), c.var.user.id)
      .first<{ r2_raw_key: string | null; subject: string }>();
    if (!row?.r2_raw_key) return c.json({ error: 'not_found' }, 404);
    const obj = await c.env.MAIL_STORE.get(row.r2_raw_key);
    if (!obj) return c.json({ error: 'not_found' }, 404);
    const name = (row.subject || 'message').replace(/[^\w一-鿿-]+/g, '_').slice(0, 60);
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'message/rfc822',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.eml`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=0',
      },
    });
  });

  /* ---------- 下載會議邀請 .ics（加入行事曆） ---------- */
  app.get('/messages/:id/calendar.ics', async (c) => {
    const row = await c.var.db.prepare(
      `SELECT calendar_event, subject FROM messages WHERE id = ? AND user_id = ?`,
    )
      .bind(c.req.param('id'), c.var.user.id)
      .first<{ calendar_event: string | null; subject: string }>();
    if (!row?.calendar_event) return c.json({ error: 'not_found' }, 404);
    const obj = await c.env.MAIL_STORE.get(r2CalKey(c.var.user.id, c.req.param('id')));
    if (!obj) return c.json({ error: 'not_found' }, 404);
    const name = (row.subject || 'invite').replace(/[^\w一-鿿-]+/g, '_').slice(0, 60);
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.ics`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=0',
      },
    });
  });

  /* ---------- 一鍵退訂（List-Unsubscribe） ---------- */
  app.post('/messages/:id/unsubscribe', async (c) => {
    const row = await c.var.db.prepare(`SELECT list_unsubscribe, from_addr FROM messages WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), c.var.user.id)
      .first<{ list_unsubscribe: string | null; from_addr: string }>();
    if (!row?.list_unsubscribe) return c.json({ error: 'not_found' }, 404);
    const u = JSON.parse(row.list_unsubscribe) as { httpUrl: string | null; mailto: string | null; oneClick: boolean };

    // F2.8b：記下「使用者已對此寄件者退訂」的意圖（即使上游 one-click 失敗仍記，因對方常照寄不誤）。
    // 之後同寄件者再寄來 → ingest 自動歸檔。best-effort：失敗不阻斷退訂動作。
    if (row.from_addr) {
      try {
        await c.var.db.prepare(`INSERT OR IGNORE INTO unsubscribed_senders (user_id, sender, created_at) VALUES (?, ?, ?)`)
          .bind(c.var.user.id, row.from_addr.toLowerCase(), Date.now())
          .run();
      } catch (err) {
        console.error('record unsubscribe failed', err);
      }
    }

    // RFC 8058 一鍵退訂：由伺服器端代送 POST（驗 https + 公開主機，保護使用者隱私、不直接從瀏覽器打）
    if (u.oneClick && u.httpUrl && isPublicHttpsUrl(u.httpUrl)) {
      try {
        // 跟隨 3xx 時每一跳重驗（見 postOneClickUnsubscribe）；不回傳上游狀態碼，避免變成內部探測回音管。
        const ok = await postOneClickUnsubscribe(u.httpUrl);
        return c.json({ ok, method: 'one-click' });
      } catch {
        return c.json({ ok: false, method: 'one-click', error: 'request_failed', url: u.httpUrl }, 502);
      }
    }
    // 非 one-click：回退訂連結 / mailto，由前端開啟（https 連結；mailto 預填退訂信）
    return c.json({ ok: true, method: u.httpUrl ? 'open' : 'mailto', url: u.httpUrl, mailto: u.mailto });
  });

  /* ---------- F5.3：待審決策（放行 / 永遠擋）。以「寄件者」為單位處理其所有待審信 ---------- */
  app.post('/messages/:id/screen', async (c) => {
    const id = c.req.param('id');
    const parsed = z.object({ decision: z.enum(['allow', 'block']) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const userId = c.var.user.id;
    const row = await c.var.db.prepare(`SELECT from_addr, from_name FROM messages WHERE id = ? AND user_id = ? AND screening = 1`)
      .bind(id, userId)
      .first<{ from_addr: string; from_name: string | null }>();
    if (!row) return c.json({ error: 'not_found' }, 404); // 不存在 / 非本人 / 已決策
    const sender = (row.from_addr || '').toLowerCase();

    if (parsed.data.decision === 'allow') {
      // 放行：清掉該寄件者所有待審信的 screening（進收件匣）＋ 加為聯絡人（未來＝已認識，不再被擋）。
      await c.var.db.prepare(`UPDATE messages SET screening = 0 WHERE user_id = ? AND screening = 1 AND lower(from_addr) = ?`)
        .bind(userId, sender)
        .run();
      if (sender) {
        const now = Date.now();
        try {
          await c.var.db.prepare(
            `INSERT INTO contacts (user_id, email, custom_name, note, phone, company, title, birthday, address, created_at, updated_at)
             VALUES (?, ?, ?, '', '', '', '', '', '', ?, ?) ON CONFLICT(user_id, email) DO NOTHING`,
          )
            .bind(userId, sender, row.from_name || '', now, now)
            .run();
        } catch (err) {
          console.error('screen allow add-contact failed', err); // best-effort：聯絡人加失敗不阻斷放行
        }
      }
      return c.json({ ok: true, decision: 'allow' });
    }

    // 永遠擋：該寄件者所有待審信移 spam ＋ 清 screening ＋ 建規則 fromContains→spam（未來自動進垃圾；已存在則不重複建）。
    await c.var.db.prepare(`UPDATE messages SET folder = 'spam', screening = 0 WHERE user_id = ? AND screening = 1 AND lower(from_addr) = ?`)
      .bind(userId, sender)
      .run();
    if (sender) {
      try {
        const conditions = JSON.stringify({ fromContains: sender });
        const actions = JSON.stringify({ moveToFolder: 'spam' });
        // 僅當「已有同條件且啟用中的 spam 規則」才跳過（避免被一條停用/作用不同的同條件規則靜默壓掉 → 封鎖失效）。
        const exists = await c.var.db.prepare(`SELECT 1 FROM rules WHERE user_id = ? AND conditions = ? AND actions = ? AND enabled = 1`)
          .bind(userId, conditions, actions)
          .first();
        if (!exists) {
          await c.var.db.prepare(
            `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at)
             VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
          )
            .bind(`rul_${crypto.randomUUID().replace(/-/g, '')}`, userId, `封鎖 ${sender}`, conditions, actions, Date.now())
            .run();
        }
      } catch (err) {
        console.error('screen block add-rule failed', err); // best-effort：規則建立失敗不阻斷封鎖
      }
    }
    return c.json({ ok: true, decision: 'block' });
  });

  /* ---------- 會議邀請 RSVP：寄出 iCalendar REPLY 給組織者並記錄出席狀態 ----------
   * 完全複用既有寄信管線（把 REPLY .ics 當 text/calendar 附件塞進 send_queue 交既有 consumer），
   * 不更動已多輪硬化的 sendConsumer。使用者每次點選即送出一封反映最新出席狀態的 REPLY（冪等於組織者端）。 */
  app.post('/messages/:id/rsvp', async (c) => {
    const id = c.req.param('id');
    const parsed = z.object({ status: z.enum(['accepted', 'tentative', 'declined']) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const status = parsed.data.status;
    const user = c.var.user;

    const row = await c.var.db.prepare(
      `SELECT calendar_event, subject, message_id_header, references_header, rsvp_status FROM messages WHERE id = ? AND user_id = ?`,
    )
      .bind(id, user.id)
      .first<{ calendar_event: string | null; subject: string; message_id_header: string | null; references_header: string | null; rsvp_status: string | null }>();
    if (!row?.calendar_event) return c.json({ error: 'not_found' }, 404);
    // 狀態未變 → 不重送（避免重複按同一選項浪費外送額度）
    if (row.rsvp_status === status) return c.json({ ok: true, status, unchanged: true });

    const ev = JSON.parse(row.calendar_event) as {
      method: string | null;
      summary: string | null;
      organizer: { name: string | null; email: string | null } | null;
      uid: string | null;
    };
    const organizerEmail = ev.organizer?.email?.trim().toLowerCase();
    if (!organizerEmail) return c.json({ error: 'no_organizer' }, 400);
    // organizer 來自收到的邀請（寄件者可控）→ 本路徑繞過 /messages/send 的 zod email 驗證，這裡自行把關，
    // 避免把畸形地址塞進寄信管線（單一收件人、内容固定，不存在多收件人放大）。
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(organizerEmail)) return c.json({ error: 'bad_organizer' }, 400);
    if (ev.method === 'CANCEL' || ev.method === 'REPLY') return c.json({ error: 'not_invitable' }, 400);

    const rawObj = await c.env.MAIL_STORE.get(r2CalKey(user.id, id));
    if (!rawObj) return c.json({ error: 'not_found' }, 404);
    const rawIcs = await rawObj.text();

    const PARTSTAT: Record<typeof status, Partstat> = {
      accepted: 'ACCEPTED',
      tentative: 'TENTATIVE',
      declined: 'DECLINED',
    };
    const now = Date.now();
    const replyIcs = buildReply({
      rawIcs,
      attendeeEmail: user.email,
      attendeeName: user.display_name || null,
      partstat: PARTSTAT[status],
      dtStampMs: now,
    });
    if (!replyIcs) return c.json({ error: 'cannot_reply' }, 400);

    // REPLY .ics 存為 staged 附件（text/calendar; method=REPLY → 組織者端可自動處理出席狀態）
    const attId = newId('att');
    const attKey = r2UploadKey(user.id, attId);
    const icsType = 'text/calendar; method=REPLY; charset=utf-8';
    await c.env.MAIL_STORE.put(attKey, replyIcs, { httpMetadata: { contentType: icsType } });
    await c.var.db.prepare(
      `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'attachment', ?, ?)`,
    )
      .bind(attId, user.id, 'invite.ics', icsType, new TextEncoder().encode(replyIcs).byteLength, attKey, now)
      .run();

    const label = { accepted: '接受', tentative: '暫定', declined: '拒絕' }[status];
    // summary 來自被解析的邀請（寄件者可控，且 parseIcs 已把 \n 還原成真換行）→ 進 subject 前去除換行並限長，
    // 杜絕標頭注入、避免過長主旨。
    const summary = (ev.summary || row.subject || '會議邀請').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    const inReplyTo = row.message_id_header;
    const references = row.message_id_header
      ? `${row.references_header ?? ''} ${row.message_id_header}`.trim().slice(-2000)
      : null;
    const payload: SendPayload = {
      to: [organizerEmail],
      cc: [],
      bcc: [],
      subject: `${label}：${summary}`,
      text: `${user.display_name || user.email} ${label}了會議邀請「${summary}」。`,
      html: null,
      attachmentIds: [attId],
      inReplyTo,
      references,
      replyToMessageId: null,
      fromAlias: null,
    };
    const sndId = newId('snd');
    await c.var.db.prepare(
      `INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at) VALUES (?, ?, ?, 'scheduled', ?, ?)`,
    )
      .bind(sndId, user.id, JSON.stringify(payload), now, now)
      .run();
    await c.env.SEND_QUEUE.send({ kind: 'send', sendQueueId: sndId } satisfies SendJob, { delaySeconds: 0 });

    await c.var.db.prepare(`UPDATE messages SET rsvp_status = ? WHERE id = ? AND user_id = ?`)
      .bind(status, id, user.id)
      .run();
    // 同步行事曆事件的出席狀態
    if (ev.uid) await setEventRsvp(c.env, user.id, ev.uid, status);

    return c.json({ ok: true, status });
  });

  /* ---------- 自建會議邀請：寄 METHOD:REQUEST .ics 給與會者（複用寄信管線，不動 consumer） ---------- */
  app.post('/calendar/invite', async (c) => {
    const schema = z.object({
      summary: z.string().min(1).max(200),
      // 0 位與會者 = 個人事件（不寄信、只入自己行事曆，供重複提醒用）
      attendees: z.array(z.string().email()).max(50).default([]),
      startMs: z.number().int().positive(),
      endMs: z.number().int().positive(),
      location: z.string().max(500).optional(),
      description: z.string().max(5000).optional(),
      whenText: z.string().max(200).optional(), // 前端依使用者本地時區格式化的顯示字串（僅供正文，.ics 才是權威時間）
      // 重複規則（後端組 RRULE 字串，不收前端原始 RRULE）；提醒提前分鐘數（0=開始時，null=不提醒）
      recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).default('none'),
      reminderMin: z.number().int().min(0).max(43200).nullable().default(null),
    });
    const body = schema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const d = body.data;
    const user = c.var.user;
    const now = Date.now();

    // 時間守門：結束須晚於開始、開始在合理範圍（不早於 1 天前、不晚於 2 年後）、會議時長 ≤30 天
    // （上界同時擋掉超大 endMs 讓 new Date(ms).toISOString() 丟 RangeError）
    if (d.endMs <= d.startMs) return c.json({ error: 'bad_time' }, 400);
    if (d.startMs < now - 86400_000 || d.startMs > now + 2 * 365 * 86400_000) return c.json({ error: 'bad_time' }, 400);
    if (d.endMs > d.startMs + 30 * 86400_000) return c.json({ error: 'bad_time' }, 400);

    const summary = d.summary.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!summary) return c.json({ error: 'bad_request' }, 400);
    const attendees = [...new Set(d.attendees.map((a) => a.trim().toLowerCase()))];

    // 本網域的權威：@MAIL_DOMAIN 的與會者必須是現存使用者（比照 /messages/send，避免 typo 的內部地址靜默退信）
    const domain = `@${c.env.MAIL_DOMAIN.toLowerCase()}`;
    const internalRecips = attendees.filter((a) => a.endsWith(domain));
    // 域內與會者 → 擁有者 user id（現存 user email，或指派給 active 使用者的別名；與 send/ingest 一致）。
    const ownerByAddr = new Map<string, string>();
    if (internalRecips.length) {
      const ph = internalRecips.map(() => '?').join(',');
      const us = await c.var.db.prepare(`SELECT id, email FROM users WHERE status = 'active' AND email IN (${ph})`)
        .bind(...internalRecips)
        .all<{ id: string; email: string }>();
      for (const u of us.results) ownerByAddr.set(u.email, u.id);
      const al = await c.var.db.prepare(
        `SELECT a.address, a.user_id FROM aliases a JOIN users u ON u.id = a.user_id
         WHERE u.status = 'active' AND a.address IN (${ph})`,
      )
        .bind(...internalRecips)
        .all<{ address: string; user_id: string }>();
      for (const a of al.results) if (!ownerByAddr.has(a.address)) ownerByAddr.set(a.address, a.user_id);
      const unknown = internalRecips.find((a) => !ownerByAddr.has(a));
      if (unknown) return c.json({ error: 'unknown_internal_recipient', recipient: unknown }, 400);
    }

    const uid = `${newId('cal')}@${c.env.MAIL_DOMAIN}`;
    const RRULE_BY_FREQ = { daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' } as const;
    const RECUR_LABEL = { daily: '每天重複', weekly: '每週重複', monthly: '每月重複', yearly: '每年重複' } as const;
    const rrule = d.recurrence === 'none' ? null : RRULE_BY_FREQ[d.recurrence];
    const reminderNextMs = computeReminderNextMs(d.startMs, parseRrule(rrule), d.reminderMin, now);

    // 自建事件主體（組織者與站內與會者共用；帶重複規則）
    const ownEvent = {
      method: 'REQUEST',
      summary,
      startText: d.whenText ?? '',
      endText: null,
      startMs: d.startMs,
      endMs: d.endMs,
      allDay: false,
      location: d.location ?? null,
      description: d.description ?? null,
      organizer: { name: user.display_name || null, email: user.email },
      uid,
      rrule,
    };

    // 個人事件（0 與會者）：不寄信、不產 .ics，只入自己行事曆（供重複提醒）
    if (!attendees.length) {
      await upsertCalendarEvent(c.env, user.id, ownEvent, {
        source: 'created',
        rsvpStatus: 'accepted',
        reminderMin: d.reminderMin,
        reminderNextMs,
        authAddr: user.email,
      });
      return c.json({ ok: true, attendees: 0, personal: true });
    }

    const ics = buildRequest({
      uid,
      organizerEmail: user.email,
      organizerName: user.display_name || null,
      attendees,
      summary,
      description: d.description ?? null,
      location: d.location ?? null,
      startMs: d.startMs,
      endMs: d.endMs,
      dtStampMs: now,
      rrule,
    });

    const attId = newId('att');
    const attKey = r2UploadKey(user.id, attId);
    const icsType = 'text/calendar; method=REQUEST; charset=utf-8';
    await c.env.MAIL_STORE.put(attKey, ics, { httpMetadata: { contentType: icsType } });
    await c.var.db.prepare(
      `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'attachment', ?, ?)`,
    )
      .bind(attId, user.id, 'invite.ics', icsType, new TextEncoder().encode(ics).byteLength, attKey, now)
      .run();

    const when = d.whenText?.trim() ? d.whenText.trim().slice(0, 200) : '';
    const parts = [`${user.display_name || user.email} 邀請你參加會議：`, '', `📅 ${summary}`];
    if (when) parts.push(`🕑 ${when}`);
    if (d.recurrence !== 'none') parts.push(`🔁 ${RECUR_LABEL[d.recurrence]}`);
    if (d.location?.trim()) parts.push(`📍 ${d.location.trim()}`);
    if (d.description?.trim()) parts.push('', d.description.trim());
    parts.push('', '請在你的郵件 / 行事曆中回覆出席狀態。');

    const payload: SendPayload = {
      to: attendees,
      cc: [],
      bcc: [],
      subject: `會議邀請：${summary}`,
      text: parts.join('\n'),
      html: null,
      attachmentIds: [attId],
      inReplyTo: null,
      references: null,
      replyToMessageId: null,
      fromAlias: null,
    };
    const sndId = newId('snd');
    await c.var.db.prepare(
      `INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at) VALUES (?, ?, ?, 'scheduled', ?, ?)`,
    )
      .bind(sndId, user.id, JSON.stringify(payload), now, now)
      .run();
    await c.env.SEND_QUEUE.send({ kind: 'send', sendQueueId: sndId } satisfies SendJob, { delaySeconds: 0 });

    // 自建會議 → 入自己的行事曆（你是組織者，預設已接受；帶提醒）
    await upsertCalendarEvent(c.env, user.id, ownEvent, {
      source: 'created',
      rsvpStatus: 'accepted',
      reminderMin: d.reminderMin,
      reminderNextMs,
      authAddr: user.email,
    });

    // 站內與會者：站內直送不解析 .ics，故在此直接補寫他們的行事曆（依擁有者去重，含別名擁有者；source=received，待其 RSVP；不帶組織者的提醒）
    for (const ownerId of new Set(ownerByAddr.values())) {
      // F16.1：授權位址＝邀請人（組織者）自己。不寫的話，這些列的 auth_addr 會是空的，
      // 組織者日後真的改期／取消時反而會被授權檢查擋掉。
      await upsertCalendarEvent(c.env, ownerId, ownEvent, { source: 'received', authAddr: user.email });
    }

    return c.json({ ok: true, attendees: attendees.length });
  });

  /* ---------- 行事曆事件（月/週檢視用，依 start_ms 範圍查詢；重複事件在此展開為實例） ---------- */
  /* ---------- F11.2：行事曆 ICS 訂閱 feed 管理（token 明碼只在產生當下回傳一次） ---------- */
  app.get('/calendar/feed', async (c) => {
    const row = await c.var.db.prepare(`SELECT created_at FROM cal_feed_tokens WHERE user_id = ?`)
      .bind(c.var.user.id)
      .first<{ created_at: number }>();
    return c.json({ active: !!row, createdAt: row?.created_at ?? null });
  });

  app.post('/calendar/feed', async (c) => {
    const token = randomToken();
    await c.var.db.prepare(
      `INSERT INTO cal_feed_tokens (user_id, token_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
    )
      .bind(c.var.user.id, await sha256Hex(token), Date.now())
      .run();
    // 重生即撤銷舊 token（同列覆寫）
    return c.json({ url: `${new URL(c.req.url).origin}/cal/${token}.ics` });
  });

  app.delete('/calendar/feed', async (c) => {
    await c.var.db.prepare(`DELETE FROM cal_feed_tokens WHERE user_id = ?`).bind(c.var.user.id).run();
    return c.json({ ok: true });
  });

  // F16.2：使用者確認後真正移除一筆行事曆事件。
  // 這同時補掉一個既有缺口——在此之前全樹**完全沒有**手動刪除行事曆事件的路徑
  //（/calendar/* 無刪除端點、admin 批次不含此表、purge.ts 不碰、UI 也沒有刪除鍵），
  // 正是「拒絕外來取消」原本不可行的原因：被拒的取消會讓事件永遠移不掉。
  app.post('/calendar/events/:id/remove', async (c) => {
    const ok = await deleteCalendarEvent(c.env, c.var.user.id, c.req.param('id'));
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  // F16.2：使用者選擇保留——清掉「待確認取消」與「被拒的外來修改」兩種警示，事件照常留著。
  app.post('/calendar/events/:id/keep', async (c) => {
    const ok = await dismissCalendarFlags(c.env, c.var.user.id, c.req.param('id'));
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  app.get('/calendar/events', async (c) => {
    const from = Number(c.req.query('from'));
    const qTo = Number(c.req.query('to'));
    if (!Number.isFinite(from) || !Number.isFinite(qTo) || qTo <= from) return c.json({ error: 'bad_request' }, 400);
    // 守門：窗口 ≤400 天（前端最寬 = 月檢視 6 週格前後各補 1 天 = 44 天）。無上限的窗口會讓生日虛擬事件
    // 逐年展開出上億個物件、撐爆 isolate（連累同 isolate 的其他請求）→ 比照 /agenda 截斷而非報錯。
    const to = Math.min(qTo, from + 400 * 86400_000);
    type Row = {
      id: string; summary: string; start_ms: number; end_ms: number | null; start_text: string;
      all_day: number; floating: number; location: string; organizer: string; source: string;
      rsvp_status: string | null; message_id: string | null; rrule: string | null;
      cancel_pending: number; cancel_by: string; blocked_at: number | null; blocked_by: string;
    };
    // 單次事件：落在範圍內者。重複事件：base 起點早於範圍尾者皆可能有實例落入 → 全撈後展開。
    const [single, recurring] = await Promise.all([
      c.var.db.prepare(
        `SELECT id, summary, start_ms, end_ms, start_text, all_day, floating, location, organizer, source, rsvp_status, message_id, rrule,
                cancel_pending, cancel_by, blocked_at, blocked_by
         FROM calendar_events WHERE user_id = ? AND rrule IS NULL AND start_ms >= ? AND start_ms < ? ORDER BY start_ms ASC LIMIT 1000`,
      ).bind(c.var.user.id, from, to).all<Row>(),
      c.var.db.prepare(
        `SELECT id, summary, start_ms, end_ms, start_text, all_day, floating, location, organizer, source, rsvp_status, message_id, rrule,
                cancel_pending, cancel_by, blocked_at, blocked_by
         FROM calendar_events WHERE user_id = ? AND rrule IS NOT NULL AND start_ms < ? ORDER BY start_ms ASC LIMIT 200`,
      ).bind(c.var.user.id, to).all<Row>(),
    ]);

    const p2 = (n: number) => String(n).padStart(2, '0');
    const utcWall = (ms: number) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    };
    const toEvent = (r: Row, startMs: number, endMs: number | null, recurring: boolean) => ({
      id: recurring ? `${r.id}:${startMs}` : r.id, // 實例 id 帶發生時間，確保前端 key 唯一
      summary: r.summary,
      startMs,
      endMs,
      startText: recurring ? utcWall(startMs) : r.start_text,
      allDay: !!r.all_day,
      floating: !!r.floating,
      location: r.location,
      organizer: r.organizer,
      source: r.source,
      rsvpStatus: r.rsvp_status,
      messageId: r.message_id,
      recurring,
      // F16.2 / F16.1：待確認的取消，與被拒絕的外來修改——兩者都要讓使用者看得見
      rowId: r.id as string | null, // 重複事件的 id 帶了發生時間，確認移除/保留要用原始列 id
      cancelPending: !!r.cancel_pending,
      cancelBy: r.cancel_by || null,
      blockedAt: r.blocked_at,
      blockedBy: r.blocked_by || null,
    });

    const events = single.results.map((r) => toEvent(r, r.start_ms, r.end_ms, false));
    for (const r of recurring.results) {
      const rule = parseRrule(r.rrule);
      if (!rule) continue; // 無法解析的規則 → 略過（不顯示，避免錯誤展開）
      const dur = r.end_ms != null ? r.end_ms - r.start_ms : null;
      for (const occ of expandOccurrences(r.start_ms, rule, from, to)) {
        events.push(toEvent(r, occ, dur != null ? occ + dur : null, true));
      }
    }
    // F11.3：聯絡人生日 → 年度虛擬全天事件（不寫 events 表；閏年 2/29 平年落 2/28）
    try {
      const bdays = await c.var.db.prepare(
        `SELECT email, custom_name, birthday FROM contacts WHERE user_id = ? AND birthday != '' LIMIT 500`,
      )
        .bind(c.var.user.id)
        .all<{ email: string; custom_name: string; birthday: string }>();
      for (const b of bdays.results) {
        const md = parseBirthday(b.birthday);
        if (!md) continue;
        for (const occ of birthdayOccurrences(md, from, to)) {
          events.push({
            id: `bday:${b.email}:${occ}`,
            summary: `🎂 ${b.custom_name || b.email} 生日`,
            startMs: occ,
            endMs: null,
            startText: '',
            allDay: true,
            floating: false,
            location: '',
            organizer: '',
            source: 'created',
            rsvpStatus: null,
            messageId: null,
            recurring: true,
            // 虛擬事件（不在 calendar_events 表裡）→ 沒有真實列 id，也沒有取消/被拒的概念
            rowId: null,
            cancelPending: false,
            cancelBy: null,
            blockedAt: null,
            blockedBy: null,
          });
        }
      }
    } catch (err) {
      console.error('birthday synth failed', err); // best-effort：不影響行事曆主資料
    }
    // F14.1：外部 ICS 訂閱 → 唯讀虛擬事件（KV 快取，cron 每 6h 更新）。單次事件落窗即入；重複事件展開。
    try {
      const cached = await c.env.KV.get(icsCacheKey(c.var.user.id));
      if (cached) {
        const cache = JSON.parse(cached) as IcsCache;
        for (const e of cache.events) {
          if (e.startMs == null) continue; // 無精確 epoch（TZID/floating）→ 不落點顯示
          const dur = e.endMs != null && e.endMs > e.startMs ? e.endMs - e.startMs : null;
          const occs = e.rrule
            ? (parseRrule(e.rrule) ? expandOccurrences(e.startMs, parseRrule(e.rrule)!, from, to) : [])
            : (e.startMs >= from && e.startMs < to ? [e.startMs] : []);
          for (const occ of occs) {
            events.push({
              id: `ext:${e.uid}:${occ}`,
              summary: e.summary,
              startMs: occ,
              endMs: dur != null ? occ + dur : e.endMs,
              startText: e.startText,
              allDay: e.allDay,
              floating: false,
              location: e.location,
              organizer: e.feed, // 借 organizer 欄顯示來源 feed 名
              source: 'external',
              rsvpStatus: null,
              messageId: null,
              recurring: !!e.rrule,
              // 外部訂閱是唯讀虛擬事件，同上
              rowId: null,
              cancelPending: false,
              cancelBy: null,
              blockedAt: null,
              blockedBy: null,
            });
          }
        }
      }
    } catch (err) {
      console.error('external ics synth failed', err); // best-effort：壞快取不影響主資料
    }

    events.sort((a, b) => a.startMs - b.startMs);
    return c.json({ events: events.slice(0, 1000) });
  });

  /* ---------- 跟進提醒：稍後跟進 / 寄出等回覆 ---------- */
  app.post('/messages/:id/followup', async (c) => {
    const id = c.req.param('id');
    const parsed = z.object({ dueAt: z.number().int().positive(), awaitReply: z.boolean().default(false) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const { dueAt, awaitReply } = parsed.data;
    const now = Date.now();
    if (dueAt < now - 60_000 || dueAt > now + 2 * 365 * 86400_000) return c.json({ error: 'bad_time' }, 400);
    const m = await c.var.db.prepare(`SELECT thread_id, subject, received_at FROM messages WHERE id = ? AND user_id = ?`)
      .bind(id, c.var.user.id)
      .first<{ thread_id: string; subject: string; received_at: number }>();
    if (!m) return c.json({ error: 'not_found' }, 404);
    await c.var.db.prepare(
      `INSERT INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, ref_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET
         due_at = excluded.due_at, await_reply = excluded.await_reply, ref_at = excluded.ref_at, status = 'pending', subject = excluded.subject`,
    )
      .bind(newId('fup'), c.var.user.id, id, m.thread_id, m.subject, dueAt, awaitReply ? 1 : 0, m.received_at, now)
      .run();
    return c.json({ ok: true });
  });

  app.get('/followups', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, message_id, subject, due_at, await_reply, status FROM follow_ups
       WHERE user_id = ? AND status IN ('pending','fired') ORDER BY (status = 'fired') DESC, due_at ASC LIMIT 200`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; message_id: string; subject: string; due_at: number; await_reply: number; status: string }>();
    return c.json({
      followups: rows.results.map((r) => ({
        id: r.id,
        messageId: r.message_id,
        subject: r.subject,
        dueAt: r.due_at,
        awaitReply: !!r.await_reply,
        status: r.status,
      })),
    });
  });

  app.post('/followups/:id/done', async (c) => {
    await c.var.db.prepare(`UPDATE follow_ups SET status = 'done' WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), c.var.user.id)
      .run();
    return c.json({ ok: true });
  });

  /* ---------- F14.3：規則建議 nudge ----------
   * 純統計、無 AI、無新表：觀察「此寄件者現有信件的資料夾分布」。
   * 誠實邊界：量測的是「目前分布」（不是操作歷史）——archive 佔多數且量夠 → 建議自動歸檔。
   * 抑制：已有涵蓋此寄件者的規則、或 archive 未達門檻，一律回 null（不打擾）。 */
  app.get('/messages/:id/rule-hint', async (c) => {
    const userId = c.var.user.id;
    const msg = await c.var.db.prepare(`SELECT from_addr, from_name FROM messages WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), userId)
      .first<{ from_addr: string; from_name: string | null }>();
    if (!msg || !msg.from_addr) return c.json({ hint: null });

    // 此寄件者各資料夾筆數（入站信；排除 spam/trash 噪音）
    const dist = await c.var.db.prepare(
      `SELECT folder, COUNT(*) AS n FROM messages
       WHERE user_id = ? AND direction = 'inbound' AND from_addr = ? AND folder NOT IN ('spam','trash')
       GROUP BY folder`,
    )
      .bind(userId, msg.from_addr)
      .all<{ folder: string; n: number }>();
    const byFolder = Object.fromEntries(dist.results.map((r) => [r.folder, r.n]));
    const archived = byFolder.archive ?? 0;
    const total = dist.results.reduce((s, r) => s + r.n, 0);
    // 門檻：≥5 封已在 archive 且佔此寄件者可見信 ≥60% → 才建議（避免偶發歸檔誤觸）
    if (archived < 5 || archived / total < 0.6) return c.json({ hint: null });

    // 抑制：已有任何 from-clause 命中此寄件者的規則（不論動作）——避免重複建議
    const rules = await c.var.db.prepare(`SELECT conditions FROM rules WHERE user_id = ?`)
      .bind(userId)
      .all<{ conditions: string }>();
    const covered = rules.results.some((r) => {
      try {
        const cond = JSON.parse(r.conditions) as { clauses?: { field: string; value: string }[]; fromContains?: string };
        // from_addr 於 ingest 已全小寫；rulesEngine 比對時對 value 也 toLowerCase → 這裡對齊，避免大寫規則漏抑制
        if (cond.fromContains && msg.from_addr.includes(cond.fromContains.toLowerCase())) return true;
        return (cond.clauses ?? []).some((cl) => cl.field === 'from' && msg.from_addr.includes(cl.value.toLowerCase()));
      } catch {
        return false;
      }
    });
    if (covered) return c.json({ hint: null });

    return c.json({ hint: { fromAddr: msg.from_addr, fromName: msg.from_name ?? '', archived, total } });
  });

  /* ---------- 對話串扇出的邊界（F19.1／2026-09-20 掃描 F3） ----------
     對話串成員由寄件者自選的 In-Reply-To/References 決定，而原本的實作沒有任何上限：
     查詢無 LIMIT、Promise.all 對每一列同時拉 R2 內文 + 附件 + 首見查詢、每份 HTML 再過一次
     HTMLRewriter。攻擊者寄 20 封各約 20 MB 的信掛同一串，受害者點開任一封就會在單一 isolate 裡
     配置數百 MB → 超過上限會**連帶殺掉同一個 isolate 上其他使用者的請求**，而那一串對受害者
     形同永久打不開（每次重試都再 OOM 一次）。
     三道邊界：撈幾列（MAX_THREAD_MESSAGES）、載幾份內文（MAX_THREAD_BODIES）、內文總位元組
     （MAX_THREAD_BODY_BYTES），外加一個小併發池取代無上限的 Promise.all。
     一般對話串（數封、每封數十 KB）完全碰不到這些數字，行為不變。 */
  const MAX_THREAD_MESSAGES = 200;
  const MAX_THREAD_BODIES = 20;
  const MAX_THREAD_BODY_BYTES = 2 * 1024 * 1024;
  /** 同時進行的「每封信工作」上限。最壞情況記憶體 ≈ 本數 × 單封 HTML 上限，故刻意取小。 */
  const THREAD_FANOUT = 3;

  /* ---------- 今日聚合：信×行事曆×跟進×排程 收斂成單一時間軸 ---------- */
  app.get('/agenda', async (c) => {
    const def = taipeiDayWindow(Date.now());
    const qFrom = Number(c.req.query('from'));
    const qTo = Number(c.req.query('to'));
    // 前端傳本地當日窗口；缺省/非法以台北日。守門：有效數字、to>from、窗口 ≤48h（防超大範圍掃全表）。
    const from = Number.isFinite(qFrom) && qFrom > 0 ? qFrom : def.from;
    const to = Number.isFinite(qTo) && qTo > from && qTo - from <= 48 * 3600_000 ? qTo : from + 86_400_000;
    const items = await buildAgenda(c.env, c.var.user.id, from, to, c.var.db);
    return c.json({ items });
  });

  /* ---------- 對話串閱讀 ---------- */
  app.get('/messages/:id', async (c) => {
    const userId = c.var.user.id;
    const id = c.req.param('id');
    // 效能：本信/整串/靜音旗標/便利貼原為 4 波循序（D1 在 WNAM 時各要一趟跨太平洋）。
    // 後三者都只需要 id+userId（靜音/便利貼一樣改用子查詢取 thread_id，不必等本信那筆先回來）
    // → 四句一次 batch 送出（1 趟 D1 往返）。授權檢查仍在下方等 msgRes 回來後才做、才組回應內容，
    // 不因為四句同一趟送出就提前使用其餘三句的結果（子查詢本身也已用 user_id 收斂，未授權時自然查無資料）。
    const [msgRes, threadRes, threadRowRes, noteRowRes] = await c.var.db.batch([
      c.var.db.prepare(`SELECT * FROM messages WHERE id = ? AND user_id = ?`).bind(id, userId),
      c.var.db.prepare(
        `SELECT m.*,
                (SELECT GROUP_CONCAT(label_id) FROM message_labels WHERE message_id = m.id) AS label_ids
         FROM messages m
         WHERE m.user_id = ?1 AND m.folder != 'trash'
           AND m.thread_id = (SELECT thread_id FROM messages WHERE id = ?2 AND user_id = ?1)
         -- F19.1（掃描 F3）：對話串歸屬完全由寄件者的 In-Reply-To/References 決定，沒有上限 =
         -- 寄 N 封信掛同一串就能讓一次讀信請求撈出任意多列。取**最新**的 MAX_THREAD_MESSAGES 封
         -- （故用 DESC + LIMIT，下方再轉回時間順序）——長串裡真正會被看的是新的那幾封。
         ORDER BY m.received_at DESC LIMIT ${MAX_THREAD_MESSAGES}`,
      ).bind(userId, id),
      // F9.7：便利貼僅自己可見。muted/note 原為兩趟循序查詢，這裡併入同一趟 batch。
      c.var.db.prepare(
        `SELECT muted FROM threads
         WHERE user_id = ?1 AND id = (SELECT thread_id FROM messages WHERE id = ?2 AND user_id = ?1)`,
      ).bind(userId, id),
      c.var.db.prepare(
        `SELECT note, updated_at FROM thread_notes
         WHERE user_id = ?1 AND thread_id = (SELECT thread_id FROM messages WHERE id = ?2 AND user_id = ?1)`,
      ).bind(userId, id),
    ]);
    const msg = (msgRes.results as (Record<string, unknown> & { thread_id: string })[])[0];
    if (!msg) return c.json({ error: 'not_found' }, 404);
    const threadRows = threadRes as unknown as {
      results: (MsgListRow & { to_addrs: string; cc_addrs: string; r2_html_key: string | null; remote_images: number; direction: string; ai_summary: string | null; ai_translation: string | null; snoozed_until: number | null })[];
    };
    const threadRow = (threadRowRes.results as { muted: number }[])[0] as { muted: number } | undefined;
    const noteRow = (noteRowRes.results as { note: string; updated_at: number }[])[0] as { note: string; updated_at: number } | undefined;

    // 查詢改成 DESC + LIMIT（F19.1）→ 這裡轉回時間順序，前端與下方邏輯看到的順序不變
    threadRows.results.reverse();

    // 確保目前這封包含在 thread（trash 開信時單獨回傳）
    const inThread = threadRows.results.some((m) => m.id === id);

    const threadSource = inThread ? threadRows.results : [...threadRows.results, msg as never];
    // 內文載入的優先序：被請求的那一封最先，其餘由新到舊。預算用完時被犧牲的，
    // 是使用者最不可能展開的那幾封（讀信視窗預設只展開最後一封與未讀，其餘是摺疊卡片）。
    const loadOrder = [...threadSource].sort((a, b) => {
      if (a.id === id) return -1;
      if (b.id === id) return 1;
      return ((b.received_at as number) ?? 0) - ((a.received_at as number) ?? 0);
    });
    let bodyBudget = MAX_THREAD_BODY_BYTES;
    let bodiesLoaded = 0;

    const buildOne = async (m: (typeof threadSource)[number]) => {
        // 先佔額度再載入：份數與位元組任一用完，這封就只回中繼資料，並帶 htmlOmitted 讓前端說明清楚。
        const wantBody = !!m.r2_html_key && bodiesLoaded < MAX_THREAD_BODIES && bodyBudget > 0;
        if (wantBody) bodiesLoaded++;
        // 效能：R2 內文、附件、首次來信三者互不相依 → 併發。原本循序 await，D1 在 WNAM 時每封信要 3 趟跨區來回。
        const [rawHtml, atts, priorFromSender] = await Promise.all([
          // 邊緣快取（lib/edgeCache.ts）：admin/messages/resanitize 端點會用同一個 r2_html_key
          // 覆寫 R2 內容 → html 並非真正 immutable，TTL 只取 24 小時（EDGE_CACHE_TTL.html 註解）。
          // 全域撤回：edgeCacheKey 內建 HTML_CACHE_VER 版本段（html/v<N>/…），線上快到壞內容時
          // 改那個數字重新部署，即可讓所有 colo 的舊 html 快取項目全部失效，不必等 TTL 到期。
          // 授權在前：上方 `SELECT * FROM messages WHERE id = ? AND user_id = ?` 不中就已經 404 返回；
          // 整串那句也綁 m.user_id = ?1 → 能走到這一行的每個 m 都已確認屬於 c.var.user.id，
          // 之後才查快取。合成 key 內含的 r2_html_key 帶 user_id + message_id，本身也不可猜。
          // F19.1：內文受「份數 + 累積位元組」雙重預算控管。額度**先佔再載**，
          // 否則同一批併發的幾封會同時判斷為可載，超出上限。
          wantBody
            ? edgeCachedText(
                c,
                edgeCacheKey('html', m.r2_html_key as string),
                EDGE_CACHE_TTL.html,
                () => c.env.MAIL_STORE.get(m.r2_html_key as string).then((o) => (o ? o.text() : '')),
              )
            : Promise.resolve(''),
          c.var.db.prepare(
            `SELECT id, filename, mime_type, size_bytes, disposition, content_id FROM attachments WHERE message_id = ?`,
          )
            .bind(m.id)
            .all<{ id: string; filename: string; mime_type: string; size_bytes: number; disposition: string | null; content_id: string | null }>(),
          m.direction === 'inbound'
            ? c.var.db.prepare(
                `SELECT 1 FROM messages WHERE user_id = ? AND direction = 'inbound' AND from_addr = ? AND received_at < ? LIMIT 1`,
              )
                .bind(userId, m.from_addr, m.received_at)
                .first()
            : Promise.resolve(null),
        ]);
        // F13.1：serve 時標記引文容器（data-quote），前端顯示層摺疊；老信同樣涵蓋。
        // try/catch 邊界：標記失敗退回原文（Promise.all 內一顆爛信不可拖垮整串 500）
        if (wantBody) bodyBudget -= rawHtml.length; // 實際大小回來後才知道花了多少
        let html = rawHtml;
        let hasQuote = false;
        if (html) {
          try {
            ({ html, hasQuote } = await markQuotedHtml(html));
          } catch {
            hasQuote = false;
          }
        }
        return {
          ...listItem(m),
          to: JSON.parse((m.to_addrs as string) ?? '[]') as string[],
          cc: JSON.parse((m.cc_addrs as string) ?? '[]') as string[],
          direction: m.direction,
          folder: (m as unknown as { folder: string }).folder,
          html,
          hasQuote,
          // F19.1：這封有內文但本次沒載（份數或位元組預算用完）。前端要說清楚，
          // 不能讓使用者看到一封空白信而以為信件壞了。
          htmlOmitted: !!m.r2_html_key && !wantBody,
          remoteImages: !!m.remote_images,
          // 收信是兩段式：email() handler 先同步 INSERT 中繼資料（含 snippet、r2_raw_key），
          // sanitize → 寫 R2 → 回填 r2_html_key/remote_images 則由 INGEST_QUEUE consumer 稍後做
          // （jobs/ingestConsumer.ts 的同一行 UPDATE）。在這個空檔開信，html 是空字串、
          // remote_images 也還是 0 —— 前端若照常渲染，使用者看到的是一封「內文空白、連
          // 『已封鎖遠端資源』提示都沒有」的信（2026-09-19 實測，這正是該現象的成因）。
          // 與其假裝成一封空信，不如把中間態誠實回報，讓前端顯示處理中並自己重抓。
          processing: m.direction === 'inbound' && !m.r2_html_key,
          unsubResend: !!(m as unknown as { unsub_resend?: number }).unsub_resend, // F2.8b：已退訂卻又寄來
          screening: !!(m as unknown as { screening?: number }).screening, // F5.3：待審（首見+未驗證）
          // 寄件者信任卡：SPF/DKIM/DMARC 結果 + 首次來信偵測（僅入站信，且查同址有無更早的信）。
          authVerdict: (m as unknown as { auth_verdict: string | null }).auth_verdict
            ? (JSON.parse((m as unknown as { auth_verdict: string }).auth_verdict) as {
                spf: string | null;
                dkim: string | null;
                dmarc: string | null;
              })
            : null,
          isNewSender: m.direction === 'inbound' ? !priorFromSender : false, // 已於上方併發查妥
          aiSummary: m.ai_summary ? (JSON.parse(m.ai_summary as string) as Record<string, unknown>) : null,
          aiTranslation: (m.ai_translation as string | null) ?? null,
          snoozedUntil: (m.snoozed_until as number | null) ?? null,
          calendarEvent: (m as unknown as { calendar_event: string | null }).calendar_event
            ? (JSON.parse((m as unknown as { calendar_event: string }).calendar_event) as Record<string, unknown>)
            : null,
          rsvpStatus: (m as unknown as { rsvp_status: string | null }).rsvp_status ?? null,
          unsubscribe: (m as unknown as { list_unsubscribe: string | null }).list_unsubscribe
            ? (JSON.parse((m as unknown as { list_unsubscribe: string }).list_unsubscribe) as Record<string, unknown>)
            : null,
          attachments: atts.results
            .filter((a) => !(a.disposition === 'inline' && a.content_id))
            .map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mime_type,
              sizeBytes: a.size_bytes,
            })),
        };
    };

    // F19.1：小型併發池，取代原本對整串無上限的 Promise.all。
    // 依 loadOrder（被請求那封優先、其餘由新到舊）分批處理，批與批之間預算才會被看見；
    // 最壞情況同時在記憶體裡的內文 ≈ THREAD_FANOUT 份，而不是整串。
    const built = new Map<string, Awaited<ReturnType<typeof buildOne>>>();
    for (let i = 0; i < loadOrder.length; i += THREAD_FANOUT) {
      const slice = loadOrder.slice(i, i + THREAD_FANOUT);
      const done = await Promise.all(slice.map((m) => buildOne(m)));
      for (const d of done) built.set(d.id, d);
    }
    // 回到時間順序輸出（loadOrder 只影響載入先後，不影響回應順序）
    const thread = threadSource.map((m) => built.get(m.id as string)!).filter(Boolean);

    // F11.1：站內信 emoji 反應——以 message_id_header 跨複本共享；對外信不附（僅站內支援，誠實）。
    const rxDomain = `@${c.env.MAIL_DOMAIN.toLowerCase()}`;
    const rowsAll = (inThread ? threadRows.results : [...threadRows.results, msg as never]) as unknown as { id: string; from_addr: string; message_id_header?: string | null }[];
    const headerByMsgId = new Map<string, string>();
    for (const m2 of rowsAll) {
      if (m2.message_id_header && m2.from_addr.toLowerCase().endsWith(rxDomain)) headerByMsgId.set(m2.id, m2.message_id_header);
    }
    const reactionsByHeader = new Map<string, { emoji: string; userId: string; name: string }[]>();
    if (headerByMsgId.size) {
      const hs = [...new Set(headerByMsgId.values())];
      const rx = await c.var.db.prepare(
        `SELECT r.header, r.emoji, r.user_id, COALESCE(u.display_name, u.email) AS name
         FROM message_reactions r JOIN users u ON u.id = r.user_id
         WHERE r.header IN (${hs.map(() => '?').join(',')}) ORDER BY r.created_at`,
      )
        .bind(...hs)
        .all<{ header: string; emoji: string; user_id: string; name: string }>();
      for (const r of rx.results) {
        const arr = reactionsByHeader.get(r.header) ?? [];
        arr.push({ emoji: r.emoji, userId: r.user_id, name: r.name });
        reactionsByHeader.set(r.header, arr);
      }
    }
    const threadOut = thread.map((t) => {
      const h = headerByMsgId.get((t as { id: string }).id);
      if (!h) return t;
      const grouped: Record<string, { count: number; mine: boolean; names: string[] }> = {};
      for (const r of reactionsByHeader.get(h) ?? []) {
        const g = (grouped[r.emoji] ??= { count: 0, mine: false, names: [] });
        g.count += 1;
        if (r.userId === userId) g.mine = true;
        if (g.names.length < 6) g.names.push(r.name);
      }
      return { ...t, internal: true, reactions: Object.entries(grouped).map(([emoji, g]) => ({ emoji, ...g })) };
    });

    return c.json({
      id,
      threadId: msg.thread_id,
      thread: threadOut,
      muted: threadRow?.muted === 1,
      note: noteRow?.note ?? '',
      noteUpdatedAt: noteRow?.updated_at ?? null,
    });
  });

  /* ---------- F11.1：站內信 emoji 反應（toggle；固定白名單；僅站內信） ---------- */
  const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '🙏'] as const;
  app.post('/messages/:id/react', async (c) => {
    const body = z.object({ emoji: z.enum(REACTION_EMOJI) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const userId = c.var.user.id;
    const m = await c.var.db.prepare(`SELECT message_id_header, from_addr FROM messages WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), userId)
      .first<{ message_id_header: string | null; from_addr: string }>();
    if (!m) return c.json({ error: 'not_found' }, 404);
    if (!m.message_id_header || !m.from_addr.toLowerCase().endsWith(`@${c.env.MAIL_DOMAIN.toLowerCase()}`)) {
      return c.json({ error: 'not_internal' }, 400); // 對外信不支援（收件人根本看不到）
    }
    const del = await c.var.db.prepare(`DELETE FROM message_reactions WHERE header = ? AND user_id = ? AND emoji = ?`)
      .bind(m.message_id_header, userId, body.data.emoji)
      .run();
    let reacted = false;
    if ((del.meta.changes ?? 0) === 0) {
      await c.var.db.prepare(`INSERT OR IGNORE INTO message_reactions (header, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`)
        .bind(m.message_id_header, userId, body.data.emoji, Date.now())
        .run();
      reacted = true;
    }
    // 同 header 其他複本擁有者 WS 即時刷新（best-effort）
    try {
      const owners = await c.var.db.prepare(`SELECT DISTINCT user_id FROM messages WHERE message_id_header = ? AND user_id != ?`)
        .bind(m.message_id_header, userId)
        .all<{ user_id: string }>();
      for (const o of owners.results) await notifyUser(c.env, o.user_id, { type: 'reaction' });
    } catch (err) {
      console.error('reaction notify failed', err);
    }
    return c.json({ ok: true, reacted });
  });

  /* ---------- F9.7：線程便利貼 upsert（空字串 = 刪除） ---------- */
  app.put('/threads/:threadId/note', async (c) => {
    const body = z.object({ note: z.string().max(4000) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const userId = c.var.user.id;
    const threadId = c.req.param('threadId');
    // 確認 thread 屬於自己（threads 為每使用者列；查 messages 亦可，threads 較直接）
    const owns = await c.var.db.prepare(`SELECT 1 FROM threads WHERE id = ? AND user_id = ?`)
      .bind(threadId, userId)
      .first();
    if (!owns) return c.json({ error: 'not_found' }, 404);
    const note = body.data.note.trim();
    if (!note) {
      await c.var.db.prepare(`DELETE FROM thread_notes WHERE user_id = ? AND thread_id = ?`).bind(userId, threadId).run();
      return c.json({ ok: true, note: '' });
    }
    await c.var.db.prepare(
      `INSERT INTO thread_notes (user_id, thread_id, note, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, thread_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
    )
      .bind(userId, threadId, note, Date.now())
      .run();
    return c.json({ ok: true, note });
  });

  /* ---------- 靜音對話串：muted 串的新信日後自動跳過收件匣 + 標已讀；靜音時也封存目前在收件匣的信 ---------- */
  app.post('/messages/:id/mute', async (c) => {
    const id = c.req.param('id');
    const parsed = z.object({ muted: z.boolean() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const muted = parsed.data.muted;
    const userId = c.var.user.id;

    const row = await c.var.db.prepare(`SELECT thread_id FROM messages WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .first<{ thread_id: string }>();
    if (!row) return c.json({ error: 'not_found' }, 404);

    await c.var.db.prepare(`UPDATE threads SET muted = ? WHERE id = ? AND user_id = ?`)
      .bind(muted ? 1 : 0, row.thread_id, userId)
      .run();
    // 靜音時把該串目前在收件匣的信移到封存並標已讀（取消靜音不會還原）
    if (muted) {
      await c.var.db.prepare(
        `UPDATE messages SET folder = 'archive', is_read = 1 WHERE user_id = ? AND thread_id = ? AND folder = 'inbox'`,
      )
        .bind(userId, row.thread_id)
        .run();
    }
    return c.json({ ok: true, muted });
  });

  /* ---------- 訊息更新（已讀/星標/搬移資料夾/Snooze） ---------- */
  const patchSchema = z.object({
    unread: z.boolean().optional(),
    starred: z.boolean().optional(),
    folder: z.enum(FOLDERS).optional(),
    category: z.enum(INBOX_CATEGORIES as [InboxCategory, ...InboxCategory[]]).optional(),
    // null = 取消 snooze；數字 = snooze 到該時間（毫秒）
    snoozedUntil: z.number().int().positive().nullable().optional(),
    // 工作流通道：null = 清除；needs_reply / waiting
    status: z.enum(['needs_reply', 'waiting']).nullable().optional(),
    // 釘選：true = 釘（pinned_at = now）；false = 取消
    pinned: z.boolean().optional(),
    // F9.7：顯示用主旨改寫（僅自己可見；null/空字串 = 還原原主旨）。搜尋與回覆引用不受影響。
    subjectOverride: z.string().max(500).nullable().optional(),
  });

  function buildPatch(data: z.infer<typeof patchSchema>): { sets: string[]; binds: unknown[] } {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (data.unread !== undefined) {
      sets.push('is_read = ?');
      binds.push(data.unread ? 0 : 1);
    }
    if (data.starred !== undefined) {
      sets.push('is_starred = ?');
      binds.push(data.starred ? 1 : 0);
    }
    if (data.folder !== undefined) {
      sets.push('folder = ?');
      binds.push(data.folder);
    }
    if (data.category !== undefined) {
      sets.push('category = ?');
      binds.push(data.category);
    }
    if (data.snoozedUntil !== undefined) {
      sets.push('snoozed_until = ?');
      binds.push(data.snoozedUntil);
      // snooze 一律回到收件匣（到期才會在收件匣現身）
      if (data.snoozedUntil) {
        sets.push(`folder = 'inbox'`);
      }
    }
    if (data.status !== undefined) {
      sets.push('message_status = ?');
      binds.push(data.status);
    }
    if (data.pinned !== undefined) {
      sets.push('pinned_at = ?');
      binds.push(data.pinned ? Date.now() : null);
    }
    if (data.subjectOverride !== undefined) {
      sets.push('subject_override = ?');
      binds.push(data.subjectOverride?.trim() || null); // 空字串 = 還原
    }
    return { sets, binds };
  }

  app.patch('/messages/:id', async (c) => {
    const body = patchSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const { sets, binds } = buildPatch(body.data);
    if (!sets.length) return c.json({ error: 'bad_request' }, 400);
    const id = c.req.param('id');
    const userId = c.var.user.id;
    // 改變資料夾時，先取舊狀態供垃圾分類學習（→spam 訓練 spam；→archive / 從 spam 救回 訓練 ham）
    const newFolder = body.data.folder;
    const pre = newFolder
      ? await c.var.db.prepare(`SELECT id, folder, direction, subject, snippet, spam_trained FROM messages WHERE id = ? AND user_id = ?`)
          .bind(id, userId)
          .first<TrainableMsg & { folder: string }>()
      : null;
    const res = await c.var.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...binds, id, userId)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    if (newFolder && pre) await trainFromFolderChange(c.env, userId, [pre], newFolder);
    return c.json({ ok: true });
  });

  /* ---------- 批次操作 ---------- */
  app.post('/messages/batch', async (c) => {
    const body = z
      .object({
        ids: z.array(z.string()).min(1).max(200),
        patch: patchSchema.optional(),
        addLabelId: z.string().optional(),
        removeLabelId: z.string().optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const userId = c.var.user.id;
    const { ids } = body.data;
    const ph = ids.map(() => '?').join(',');

    const stmts: D1PreparedStatement[] = [];
    if (body.data.patch) {
      const { sets, binds } = buildPatch(body.data.patch);
      if (sets.length) {
        stmts.push(
          c.var.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE user_id = ? AND id IN (${ph})`).bind(
            ...binds,
            userId,
            ...ids,
          ),
        );
      }
    }
    if (body.data.addLabelId) {
      // 標籤須屬於本人；只對本人訊息掛標籤
      stmts.push(
        c.var.db.prepare(
          `INSERT OR IGNORE INTO message_labels (message_id, label_id)
           SELECT m.id, ? FROM messages m WHERE m.user_id = ? AND m.id IN (${ph})
             AND EXISTS (SELECT 1 FROM labels l WHERE l.id = ? AND l.user_id = ?)`,
        ).bind(body.data.addLabelId, userId, ...ids, body.data.addLabelId, userId),
      );
    }
    if (body.data.removeLabelId) {
      stmts.push(
        c.var.db.prepare(
          `DELETE FROM message_labels WHERE label_id = ? AND message_id IN (
             SELECT id FROM messages WHERE user_id = ? AND id IN (${ph}))`,
        ).bind(body.data.removeLabelId, userId, ...ids),
      );
    }
    if (!stmts.length) return c.json({ error: 'bad_request' }, 400);
    // 批次改資料夾 → 垃圾分類學習（先取舊狀態，批次套用後再訓練）
    const batchFolder = body.data.patch?.folder;
    const preMsgs = batchFolder
      ? (
          await c.var.db.prepare(
            `SELECT id, folder, direction, subject, snippet, spam_trained FROM messages WHERE user_id = ? AND id IN (${ph})`,
          )
            .bind(userId, ...ids)
            .all<TrainableMsg & { folder: string }>()
        ).results
      : [];
    await c.var.db.batch(stmts);
    if (batchFolder && preMsgs.length) await trainFromFolderChange(c.env, userId, preMsgs, batchFolder);
    return c.json({ ok: true, count: ids.length });
  });

  // F4.7：依「目前虛擬夾/視圖」批次處理全部符合的信（非僅本頁）——一條 WHERE 直接 UPDATE。
  // 只允許可復原動作（標已讀 / 封存），不做刪除；視圖只開放定義明確的 lane + 可選寄件者。
  app.post('/messages/batch-by-view', async (c) => {
    const body = z
      .object({
        view: z.enum(['newsletter', 'receipt']),
        action: z.enum(['read', 'archive', 'trash']), // F9.3：trash = 移垃圾桶（可復原，30 天後由 F9.1 清）
        fromAddr: z.string().email().max(254).optional(), // 某寄件者視圖
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const userId = c.var.user.id;
    const wheres: string[] = ['user_id = ?'];
    const binds: unknown[] = [userId];
    if (body.data.view === 'newsletter') {
      wheres.push(`list_unsubscribe IS NOT NULL`, `folder NOT IN ('trash','spam')`, `screening = 0`); // 與 GET /messages newsletter lane 一致（F5.3：不動待審信）
    } else {
      wheres.push(`(${RECEIPT_KEYWORDS.map(() => 'subject LIKE ?').join(' OR ')})`, `folder NOT IN ('trash','spam')`, `screening = 0`);
      binds.push(...RECEIPT_KEYWORDS.map((k) => `%${k}%`));
    }
    if (body.data.fromAddr) {
      wheres.push(`lower(from_addr) = ?`);
      binds.push(body.data.fromAddr.toLowerCase());
    }
    // 動作皆可復原：標已讀 / 封存 / 移垃圾桶（trash 之後走 F9.1 的 30 天窗口，非立即刪）。
    // 封存者額外加「尚在 inbox」避免覆蓋既有歸檔位置；星標/釘選不移垃圾桶（明確保留訊號）。
    const set = body.data.action === 'read' ? `is_read = 1` : body.data.action === 'archive' ? `folder = 'archive'` : `folder = 'trash'`;
    if (body.data.action === 'archive') wheres.push(`folder = 'inbox'`);
    if (body.data.action === 'trash') wheres.push(`is_starred = 0`, `pinned_at IS NULL`);
    // 回給使用者的數量先 COUNT 再 UPDATE：0037 的 folder trigger 會把 meta.changes 灌成兩倍
    //（每列多一次 folder_changed_at 連帶更新），直接回 meta.changes 會顯示「已封存 2N 封」。
    const n = await c.var.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${wheres.join(' AND ')}`)
      .bind(...binds)
      .first<{ n: number }>();
    await c.var.db.prepare(`UPDATE messages SET ${set} WHERE ${wheres.join(' AND ')}`).bind(...binds).run();
    return c.json({ ok: true, changes: n?.n ?? 0 });
  });

  /* ---------- F9.3：訂閱管理儀表板 ----------
   * 聚合電子報 lane（list_unsubscribe 為強訊號）by 寄件者：月量/總數/最後一封/最新一封 id（供退訂）。
   * 唯讀；處置動作全部重用既有端點（/messages/:id/unsubscribe、規則封鎖、batch-by-view）。 */
  app.get('/subscriptions', async (c) => {
    const userId = c.var.user.id;
    const monthAgo = Date.now() - 30 * 86400_000;
    const rows = await c.var.db.prepare(
      `SELECT lower(m.from_addr) AS addr,
              MAX(m.from_name) AS name,
              COUNT(*) AS total,
              SUM(CASE WHEN m.received_at > ?1 THEN 1 ELSE 0 END) AS last30,
              SUM(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) AS unread,
              MAX(m.received_at) AS last_at,
              (SELECT m2.id FROM messages m2
               WHERE m2.user_id = m.user_id AND lower(m2.from_addr) = lower(m.from_addr)
                 AND m2.list_unsubscribe IS NOT NULL
               ORDER BY m2.received_at DESC LIMIT 1) AS latest_id
       FROM messages m
       WHERE m.user_id = ?2 AND m.list_unsubscribe IS NOT NULL AND m.screening = 0
         AND m.folder NOT IN ('trash', 'spam')
       GROUP BY lower(m.from_addr)
       ORDER BY last_at DESC
       LIMIT 200`,
    )
      .bind(monthAgo, userId)
      .all<{ addr: string; name: string; total: number; last30: number; unread: number; last_at: number; latest_id: string }>();
    return c.json({
      subscriptions: rows.results.map((r) => ({
        addr: r.addr,
        name: r.name || r.addr,
        total: r.total,
        last30: r.last30,
        unread: r.unread,
        lastAt: r.last_at,
        latestId: r.latest_id,
      })),
    });
  });

  /* ---------- 附件下載（授權 proxy，R2 永不公開） ---------- */
  async function loadAttachment(c: { var: { db: D1DatabaseSession } }, userId: string, id: string) {
    return c.var.db.prepare(`SELECT * FROM attachments WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .first<{ id: string; filename: string; mime_type: string; r2_key: string }>();
  }

  app.get('/attachments/:id', async (c) => {
    // 授權在前：attachments 這句綁 user_id，不是本人的附件在此就 404（快取查詢一律在這行之後）。
    const att = await loadAttachment(c, c.var.user.id, c.req.param('id'));
    if (!att) return c.json({ error: 'not_found' }, 404);
    // lightbox 預覽：僅安全型別允許 inline（圖片/PDF/影片/音訊——皆非可執行腳本；nosniff + 媒體元素載入）。
    // 文字檔不走 inline（前端以 fetch + <pre> 顯示，避免當成文件導覽）。
    const inlineSafe =
      att.mime_type.startsWith('image/') ||
      att.mime_type === 'application/pdf' ||
      att.mime_type.startsWith('video/') ||
      att.mime_type.startsWith('audio/');
    const inline = c.req.query('inline') === '1' && inlineSafe;
    // 標頭集合在這裡組一次，命中與未命中都用同一份 → 快取不會改變任何端點標頭。
    const headers: Record<string, string> = {
      'Content-Type': att.mime_type,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store, max-age=0', // 不把附件位元組落地磁碟快取（隱私）[Codex]
      ...(inline ? { 'Content-Security-Policy': "sandbox; default-src 'none'" } : {}),
    };
    // 邊緣快取：附件位元組不可變 → TTL 30 天。Range 請求一律繞過（不查也不寫）。
    // 快取內只放位元組，客戶端標頭永遠由上面那份 headers 重組（含 no-store：瀏覽器端行為不變）。
    const ck = c.req.header('range') ? null : edgeCacheKey('att', att.r2_key);
    if (ck) {
      const hit = await edgeCacheMatch(ck);
      if (hit) return new Response(hit.body, { headers });
    }
    const obj = await c.env.MAIL_STORE.get(att.r2_key);
    if (!obj) return c.json({ error: 'not_found' }, 404);
    const res = new Response(obj.body, { headers });
    if (ck) edgeCachePut(c, ck, res, EDGE_CACHE_TTL.att);
    return res;
  });

  /** 檔案庫：信箱內所有附件總覽（草稿上傳暫存的 message_id 為 NULL，JOIN 自然排除） */
  app.get('/files', async (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 80);
    const params: unknown[] = [c.var.user.id];
    let where = `a.user_id = ? AND a.disposition = 'attachment' AND m.folder NOT IN ('trash', 'spam')`;
    if (q) {
      where += ` AND a.filename LIKE ? ESCAPE '\\'`;
      params.push(`%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
    }
    const rows = await c.var.db.prepare(
      `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.created_at,
              m.id AS message_id, m.from_addr, m.from_name, m.subject, m.direction, m.folder
       FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE ${where}
       ORDER BY a.created_at DESC LIMIT 200`,
    )
      .bind(...params)
      .all<{
        id: string;
        filename: string;
        mime_type: string;
        size_bytes: number;
        created_at: number;
        message_id: string;
        from_addr: string;
        from_name: string;
        subject: string;
        direction: string;
        folder: string;
      }>();
    return c.json({
      files: rows.results.map((r) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mime_type,
        sizeBytes: r.size_bytes,
        ts: r.created_at,
        messageId: r.message_id,
        from: { name: r.from_name, addr: r.from_addr },
        subject: r.subject,
        direction: r.direction,
        folder: r.folder,
      })),
    });
  });

  /** cid 內嵌圖片（只允許 image/*，同源 iframe 的 <img> 取用） */
  app.get('/attachments/:id/inline', async (c) => {
    // 授權在前：同上，attachments 綁 user_id；非本人（或非影像）在此就 404，之後才可能碰快取。
    const att = await loadAttachment(c, c.var.user.id, c.req.param('id'));
    if (!att || !att.mime_type.startsWith('image/')) return c.json({ error: 'not_found' }, 404);
    // mime_type 由寄件人的 MIME part 原樣存入（email/ingest.ts）：image/svg+xml 等 XML 影像
    // 被當頂層文件開啟就是同源 XSS。比照 serveAvatar（api/settings.ts）：這類型別不照原型別
    // inline 回送，改成純下載；點陣影像（png/jpeg/gif/webp…）照舊 inline。
    const scriptable = isScriptableImageType(att.mime_type);
    const headers: Record<string, string> = {
      'Content-Type': scriptable ? 'application/octet-stream' : att.mime_type,
      'Content-Disposition': scriptable ? 'attachment' : 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
      // 比照 /attachments/:id?inline=1：即使被當頂層文件開啟也不能執行腳本／對外發請求。
      'Content-Security-Policy': "sandbox; default-src 'none'",
    };
    // 邊緣快取：位元組不可變 → TTL 30 天；Range 請求繞過。與 /attachments/:id 共用同一個 key
    // （同一份位元組），因為降級/Disposition 等安全標頭一律在這裡重組，不隨快取走。
    const ck = c.req.header('range') ? null : edgeCacheKey('att', att.r2_key);
    if (ck) {
      const hit = await edgeCacheMatch(ck);
      if (hit) return new Response(hit.body, { headers });
    }
    const obj = await c.env.MAIL_STORE.get(att.r2_key);
    if (!obj) return c.json({ error: 'not_found' }, 404);
    const res = new Response(obj.body, { headers });
    if (ck) edgeCachePut(c, ck, res, EDGE_CACHE_TTL.att);
    return res;
  });

  return app;
}
