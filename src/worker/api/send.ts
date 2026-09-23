// 寄信 / Undo / 排程 / 草稿 / 附件上傳
import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { newId } from '../lib/ids';
import { r2ShareKey, r2UploadKey } from '../lib/keys';
import { getIp, getUa, requireSession, type Vars } from './middleware';
import { rateLimitMw } from '../lib/ratelimit';
import type { SendJob } from '../jobs/types';

export const MAX_SEND_BYTES = 5 * 1024 * 1024; // 設計規格的寄信總量上限（內嵌附件）
export const SHARE_MAX_BYTES = 25 * 1024 * 1024; // 大附件轉連結上限（R2 + 公開下載）
const SHARE_TTL_MS = 7 * 24 * 3600 * 1000; // 下載連結有效 7 天
const MAX_RECIPIENTS = 50;
const DEFAULT_UNDO_SEC = 15;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 3600 * 1000;

// 「待裁決」(outbox 顯示 review) 的 send_queue 述詞——附件守門 / discard 清理共用，避免三處定義漂移。
const REVIEW_SQL = `status = 'failed' AND external_state = 'attempting' AND last_error = 'external_uncertain'`;

export interface SendPayload {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  /** 富文本（已於 send route 消毒），無則由 text 轉 HTML */
  html?: string | null;
  attachmentIds: string[];
  inReplyTo: string | null;
  references: string | null;
  replyToMessageId: string | null;
  /** Send-as 寄件身分：null=用 canonical email；否則為「本人」的 +tag 別名（已於 send route 驗證所有權）。 */
  fromAlias: string | null;
  /** F4.1b：此為「規則自動轉寄」產生的外寄 → 寄出時打 X-Miseroda-Forwarded 標頭、站內投遞帶 forwarded 旗標，
   *  使轉寄信落地時不再觸發任何轉寄規則（斷迴圈）。一般寄信不設此旗標。 */
  forwarded?: boolean;
  /** F11：X-Miseroda-Forwarded 的標頭值＝系統核發的隨機 marker（forward_markers）。
   *  只有 enqueueForwards 會設；扇回落地時查表命中才採信，遠端寄件者自寫的標頭一律不算數。 */
  forwardMarker?: string;
}

/** 取地址的 base canonical（去 +tag）。結構不合法、或 +tag 含不安全字元 → null。 */
function baseCanonical(addr: string): string | null {
  const a = addr.trim().toLowerCase();
  const m = /^([^+@\s]+)(\+[^@\s]+)?@([^@\s]+)$/.exec(a);
  if (!m) return null;
  if (m[2] && !/^\+[a-z0-9._-]+$/.test(m[2])) return null;
  return `${m[1]}@${m[3]}`;
}

/**
 * Send-as 安全閘門（Plus 別名）：fromAlias 必須是「使用者自己的」canonical email，或其 +tag 別名。
 * 防止冒用任意地址（會傷網域信譽 / 可被當釣魚）。回 plus-alias 一律能收到回信（ingest 已正規化 +tag → canonical）。
 */
export function isOwnSendIdentity(fromAlias: string, userEmail: string): boolean {
  const base = baseCanonical(fromAlias);
  return base !== null && base === userEmail.trim().toLowerCase();
}

/**
 * 允許的寄件身分 = canonical ∪ 使用者「擁有的乾淨別名」（皆含 +tag 變體）。
 * ownedAliases 為 aliases 表查得的 address 清單（prefix@domain）。
 */
export function isAllowedSendIdentity(fromAlias: string, userEmail: string, ownedAliases: string[]): boolean {
  const base = baseCanonical(fromAlias);
  if (base === null) return false;
  if (base === userEmail.trim().toLowerCase()) return true;
  return ownedAliases.some((a) => a.trim().toLowerCase() === base);
}

/**
 * F2.3：寄出的信像不像「在問人事情、需要對方回覆」→ 自動建 await_reply 跟進。
 * 純字串比對（無 regex 回溯風險）；保守：無收件人或疑似群發（>5 人）不追蹤，避免洗版。
 */
const REPLY_HINT = /[?？]|請問|麻煩|可否|能否|是否|可以嗎|方便嗎|幫我|煩請|請回|回覆|確認一下|請示|何時|幾點|哪天|是不是|對嗎/;
export function shouldTrackReply(p: { subject: string; text: string; to: string[]; cc: string[]; bcc: string[] }): boolean {
  const recipients = p.to.length + p.cc.length + p.bcc.length;
  if (recipients === 0 || recipients > 5) return false;
  return REPLY_HINT.test(`${p.subject}\n${p.text}`);
}

const draftPayloadSchema = z.object({
  to: z.string().default(''),
  cc: z.string().default(''),
  bcc: z.string().default(''),
  subject: z.string().default(''),
  body: z.string().default(''),
  bodyHtml: z.string().nullable().default(null),
  // 存完整附件 metadata，恢復草稿時 UI 直接可用（實體仍在 R2 staged 區）
  attachments: z
    .array(z.object({ id: z.string(), filename: z.string(), sizeBytes: z.number(), mimeType: z.string() }))
    .default([]),
  replyToMessageId: z.string().nullable().default(null),
  // Send-as 寄件身分（草稿只存原字串；實際寄出時由 /messages/send 的 isOwnSendIdentity 重新驗證所有權）。
  fromAlias: z.string().email().max(254).nullable().default(null),
  // 大附件下載連結（草稿保存）。
  linkFiles: z
    .array(
      z.object({
        token: z.string(),
        url: z.string(),
        filename: z.string(),
        sizeBytes: z.number(),
        expiresAt: z.number(),
      }),
    )
    .default([]),
});

export function sendRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use('*', requireSession);
  app.use('/messages/send', rateLimitMw('send', 30, 60));
  app.use('/attachments/upload', rateLimitMw('upload', 60, 60));
  app.use('/share/upload', rateLimitMw('share', 30, 60));
  app.use('/import/mbox', rateLimitMw('import', 5, 60)); // F7.6：mbox 上傳（大量寫入入口）限流
  app.use('/encrypted', rateLimitMw('encrypted', 20, 60)); // F7.7：建立加密連結

  // 撰寫器「寄件身分」清單：使用者擁有的乾淨別名（canonical 由前端 me.user.email 已知）。
  // F4.4：帶 id 與 signatureId（綁定的簽名）→ 撰寫器切身分時帶對應簽名。
  app.get('/identities', async (c) => {
    // F9.4：停用的別名不進撰寫器寄件身分清單（send 端 owned 查詢也已排除）
    const rows = await c.var.db.prepare(`SELECT id, address, name, signature_id FROM aliases WHERE user_id = ? AND disabled = 0 ORDER BY address`)
      .bind(c.var.user.id)
      .all<{ id: string; address: string; name: string | null; signature_id: string | null }>();
    return c.json({ aliases: rows.results.map((r) => ({ id: r.id, address: r.address, name: r.name, signatureId: r.signature_id })) });
  });

  /* ---------- 寄出（含 Undo 視窗 / 排程） ---------- */
  app.post('/messages/send', async (c) => {
    const schema = z.object({
      to: z.array(z.string().email()).min(1),
      cc: z.array(z.string().email()).default([]),
      bcc: z.array(z.string().email()).default([]),
      subject: z.string().max(990).default(''),
      text: z.string().max(2_000_000).default(''),
      html: z.string().max(2_000_000).nullable().optional(),
      attachmentIds: z.array(z.string()).max(20).default([]),
      replyToMessageId: z.string().nullable().optional(),
      undoWindowSec: z.number().int().min(0).max(30).default(DEFAULT_UNDO_SEC),
      scheduleAt: z.number().int().positive().nullable().optional(),
      fromAlias: z.string().email().max(254).nullable().optional(),
    });
    const body = schema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const d = body.data;
    const user = c.var.user;

    if (d.to.length + d.cc.length + d.bcc.length > MAX_RECIPIENTS) {
      return c.json({ error: 'too_many_recipients' }, 400);
    }

    // Send-as 寄件身分：只認 canonical / 本人 +tag / 本人「擁有的乾淨別名」，否則拒收（防冒用任意地址）。
    let fromAlias: string | null = null;
    if (d.fromAlias && d.fromAlias.trim().toLowerCase() !== user.email.toLowerCase()) {
      const owned = await c.var.db.prepare(`SELECT address FROM aliases WHERE user_id = ? AND disabled = 0`)
        .bind(user.id)
        .all<{ address: string }>();
      if (!isAllowedSendIdentity(d.fromAlias, user.email, owned.results.map((r) => r.address))) {
        return c.json({ error: 'bad_from_alias' }, 400);
      }
      fromAlias = d.fromAlias.trim().toLowerCase();
    }

    // 我們是本網域的權威：@miseroda.com 收件人必須是現存使用者，不用繞 SMTP 才知道退信
    const domain = `@${c.env.MAIL_DOMAIN.toLowerCase()}`;
    const internalRecips = [...new Set(
      [...d.to, ...d.cc, ...d.bcc].map((a) => a.trim().toLowerCase()).filter((a) => a.endsWith(domain)),
    )];
    if (internalRecips.length) {
      const ph = internalRecips.map(() => '?').join(',');
      // 域內收件人 = 現存使用者 email，或「指派給 active 使用者的別名」（與 ingest 路由一致）。
      const found = await c.var.db.prepare(
        `SELECT email AS addr FROM users WHERE status = 'active' AND email IN (${ph})
         UNION
         SELECT a.address AS addr FROM aliases a JOIN users u ON u.id = a.user_id
           WHERE u.status = 'active' AND a.address IN (${ph})`,
      )
        .bind(...internalRecips, ...internalRecips)
        .all<{ addr: string }>();
      const known = new Set(found.results.map((r) => r.addr));
      const unknown = internalRecips.find((a) => !known.has(a));
      if (unknown) return c.json({ error: 'unknown_internal_recipient', recipient: unknown }, 400);
    }

    // 富文本：伺服器端消毒（與 ingest 同一把白名單刀）
    let safeHtml: string | null = null;
    if (d.html?.trim()) {
      const { sanitizeEmailHtml } = await import('../email/sanitize');
      safeHtml = (await sanitizeEmailHtml(d.html, new Map())).html;
    }

    // 附件必須是自己的、尚未綁定訊息的 staged 上傳
    let attBytes = 0;
    if (d.attachmentIds.length) {
      const placeholders = d.attachmentIds.map(() => '?').join(',');
      const atts = await c.var.db.prepare(
        `SELECT id, size_bytes FROM attachments WHERE id IN (${placeholders}) AND user_id = ? AND message_id IS NULL`,
      )
        .bind(...d.attachmentIds, user.id)
        .all<{ id: string; size_bytes: number }>();
      if (atts.results.length !== d.attachmentIds.length) return c.json({ error: 'bad_attachment' }, 400);
      attBytes = atts.results.reduce((s, a) => s + a.size_bytes, 0);
    }
    const totalBytes = new TextEncoder().encode(d.text + d.subject).byteLength + attBytes;
    if (totalBytes > MAX_SEND_BYTES) return c.json({ error: 'too_large', maxBytes: MAX_SEND_BYTES }, 413);

    // 回覆串接：現在就解析 In-Reply-To / References，consumer 自包含
    let inReplyTo: string | null = null;
    let references: string | null = null;
    if (d.replyToMessageId) {
      const parent = await c.var.db.prepare(
        `SELECT message_id_header, references_header FROM messages WHERE id = ? AND user_id = ?`,
      )
        .bind(d.replyToMessageId, user.id)
        .first<{ message_id_header: string | null; references_header: string | null }>();
      if (parent?.message_id_header) {
        inReplyTo = parent.message_id_header;
        references = `${parent.references_header ?? ''} ${parent.message_id_header}`.trim().slice(-2000);
      }
    }

    const now = Date.now();
    if (d.scheduleAt && (d.scheduleAt < now || d.scheduleAt > now + MAX_SCHEDULE_AHEAD_MS)) {
      return c.json({ error: 'bad_schedule' }, 400);
    }

    const payload: SendPayload = {
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      text: d.text,
      html: safeHtml,
      attachmentIds: d.attachmentIds,
      inReplyTo,
      references,
      replyToMessageId: d.replyToMessageId ?? null,
      fromAlias,
    };

    const id = newId('snd');
    const scheduledAt = d.scheduleAt ?? now + d.undoWindowSec * 1000;
    await c.var.db.prepare(
      `INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at)
       VALUES (?, ?, ?, 'scheduled', ?, ?)`,
    )
      .bind(id, user.id, JSON.stringify(payload), scheduledAt, now)
      .run();

    if (!d.scheduleAt) {
      await c.env.SEND_QUEUE.send({ kind: 'send', sendQueueId: id } satisfies SendJob, {
        delaySeconds: d.undoWindowSec,
      });
    }
    // scheduleAt 的情況由每分鐘 cron 掃描 enqueue

    // F2.3：預測「會自動追蹤回覆」→ 讓前端在送出 toast 提示一句（實際 follow_up 由 consumer 寄成後建）。
    return c.json({ id, scheduledAt, undoWindowSec: d.scheduleAt ? 0 : d.undoWindowSec, trackReply: shouldTrackReply(payload) });
  });

  /* ---------- Undo（取消未寄出的） ---------- */
  app.post('/send/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const res = await c.var.db.prepare(
      `UPDATE send_queue SET status = 'canceled' WHERE id = ? AND user_id = ? AND status = 'scheduled'`,
    )
      .bind(id, c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'too_late' }, 409);
    const row = await c.var.db.prepare(`SELECT payload FROM send_queue WHERE id = ?`)
      .bind(id)
      .first<{ payload: string }>();
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'message.send.cancel',
      targetType: 'send_queue',
      targetId: id,
      ip: getIp(c),
      userAgent: getUa(c),
    });
    return c.json({ ok: true, payload: row ? (JSON.parse(row.payload) as SendPayload) : null });
  });

  /* ---------- Outbox：尚未成功寄出的（排程中 / 寄送中 / 失敗），供寄件備份頂部顯示徽章 ---------- */
  app.get('/outbox', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, payload, status, scheduled_at, last_error, external_state FROM send_queue
       WHERE user_id = ? AND status IN ('scheduled','sending','failed') ORDER BY scheduled_at DESC LIMIT 50`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; payload: string; status: string; scheduled_at: number; last_error: string | null; external_state: string | null }>();
    return c.json({
      items: rows.results.map((r) => {
        const p = JSON.parse(r.payload) as SendPayload;
        // 外送結果未定（attempting + external_uncertain）→ 前端顯示「待確認」並給裁決按鈕
        const uncertain = r.status === 'failed' && r.external_state === 'attempting' && r.last_error === 'external_uncertain';
        return {
          id: r.id,
          status: uncertain ? ('review' as const) : r.status,
          scheduledAt: r.scheduled_at,
          lastError: r.last_error,
          subject: p.subject,
          to: p.to,
        };
      }),
    });
  });

  /* ---------- 重寄失敗的信 ---------- */
  app.post('/send/:id/retry', async (c) => {
    const id = c.req.param('id');
    // 「待裁決」(external_state='attempting') 的列不走一般重寄，只能透過 /resolve 裁決
    const res = await c.var.db.prepare(
      `UPDATE send_queue SET status = 'scheduled', scheduled_at = ?, last_error = NULL
       WHERE id = ? AND user_id = ? AND status = 'failed' AND COALESCE(external_state, '') != 'attempting'`,
    )
      .bind(Date.now(), id, c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_failed' }, 409);
    await c.env.SEND_QUEUE.send({ kind: 'send', sendQueueId: id } satisfies SendJob);
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'message.send.retry',
      targetType: 'send_queue',
      targetId: id,
      ip: getIp(c),
      userAgent: getUa(c),
    });
    return c.json({ ok: true });
  });

  /* ---------- 裁決外送結果未定的信（resend 重寄 / sent 確認已送達 / discard 放棄整封） ---------- */
  app.post('/send/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const body = z.object({ decision: z.enum(['resend', 'sent', 'discard']) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const decision = body.data.decision;
    const now = Date.now();

    if (decision === 'discard') {
      // 放棄整封（含站內副本）→ 終態 canceled，乾淨離開 outbox；保留 external_state='attempting'
      // 作為縱深防禦（即使日後被誤 re-drive，消費端 attempting 分支也只會轉 review、不會重送）。不 re-enqueue。
      const res = await c.var.db.prepare(
        `UPDATE send_queue SET status = 'canceled', last_error = 'discarded'
         WHERE id = ? AND user_id = ? AND status = 'failed' AND external_state = 'attempting'`,
      )
        .bind(id, c.var.user.id)
        .run();
      if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_uncertain' }, 409);

      // 清理這封 review 信的 staged 附件（discard 時原草稿已於送出時刪除 → 不會誤刪正在編輯的草稿附件）。
      // 嚴格守門：僅刪 message_id IS NULL（未綁定，否則會毀掉真實寄件備份的附件）且不再被任何其他
      // active/review 寄送引用者；先刪 R2 再刪列、R2 不存在亦容忍（idempotent）。本封已是 canceled，不會自我匹配。
      const sq = await c.var.db.prepare(`SELECT payload FROM send_queue WHERE id = ?`).bind(id).first<{ payload: string }>();
      const attIds = sq ? (JSON.parse(sq.payload) as SendPayload).attachmentIds : [];
      for (const attId of attIds) {
        const att = await c.var.db.prepare(
          `SELECT r2_key FROM attachments WHERE id = ? AND user_id = ? AND message_id IS NULL`,
        )
          .bind(attId, c.var.user.id)
          .first<{ r2_key: string }>();
        if (!att) continue; // 已綁定 / 不存在 → 不動
        const stillUsed = await c.var.db.prepare(
          `SELECT 1 FROM send_queue WHERE user_id = ? AND id != ? AND payload LIKE ?
           AND (status IN ('scheduled', 'sending') OR (${REVIEW_SQL})) LIMIT 1`,
        )
          .bind(c.var.user.id, id, `%"${attId}"%`)
          .first();
        if (stillUsed) continue; // 另有未終結寄送在用 → 保留
        await c.env.MAIL_STORE.delete(att.r2_key);
        await c.var.db.prepare(`DELETE FROM attachments WHERE id = ?`).bind(attId).run();
      }

      await audit(c.var.db, {
        userId: c.var.user.id,
        action: 'message.send.resolve',
        targetType: 'send_queue',
        targetId: id,
        ip: getIp(c),
        userAgent: getUa(c),
        meta: { decision },
      });
      return c.json({ ok: true });
    }

    // resend → 清掉 attempting，重新外送 + 收尾；
    // sent → 標 accepted，重跑時跳過外送只收尾。同時補蓋 external_sent_at（維持「accepted ⟹ external_sent_at 有值」
    //        不變式——相容守門 external_sent_at!=null 也視為已接受，兩個事實來源不可分歧）。
    const res =
      decision === 'sent'
        ? await c.var.db.prepare(
            `UPDATE send_queue SET status = 'scheduled', scheduled_at = ?, last_error = NULL,
               external_state = 'accepted', external_sent_at = COALESCE(external_sent_at, ?)
             WHERE id = ? AND user_id = ? AND status = 'failed' AND external_state = 'attempting'`,
          )
            .bind(now, now, id, c.var.user.id)
            .run()
        : await c.var.db.prepare(
            `UPDATE send_queue SET status = 'scheduled', scheduled_at = ?, last_error = NULL, external_state = NULL
             WHERE id = ? AND user_id = ? AND status = 'failed' AND external_state = 'attempting'`,
          )
            .bind(now, id, c.var.user.id)
            .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_uncertain' }, 409);
    await c.env.SEND_QUEUE.send({ kind: 'send', sendQueueId: id } satisfies SendJob);
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'message.send.resolve',
      targetType: 'send_queue',
      targetId: id,
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { decision },
    });
    return c.json({ ok: true });
  });

  /* ---------- 草稿 ---------- */
  app.get('/drafts', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, payload, created_at, updated_at FROM drafts WHERE user_id = ? ORDER BY updated_at DESC`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; payload: string; created_at: number; updated_at: number }>();
    return c.json({
      drafts: rows.results.map((r) => ({
        id: r.id,
        payload: JSON.parse(r.payload) as z.infer<typeof draftPayloadSchema>,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  });

  app.post('/drafts', async (c) => {
    const body = draftPayloadSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const id = newId('drf');
    const now = Date.now();
    await c.var.db.prepare(
      `INSERT INTO drafts (id, user_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, c.var.user.id, JSON.stringify(body.data), now, now)
      .run();
    return c.json({ id });
  });

  app.patch('/drafts/:id', async (c) => {
    const body = draftPayloadSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const res = await c.var.db.prepare(
      `UPDATE drafts SET payload = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    )
      .bind(JSON.stringify(body.data), Date.now(), c.req.param('id'), c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/drafts/:id', async (c) => {
    const res = await c.var.db.prepare(`DELETE FROM drafts WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  /* ---------- 附件上傳（staged，寄出時綁定訊息） ---------- */
  app.post('/attachments/upload', async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'bad_request' }, 400);
    if (file.size > MAX_SEND_BYTES) return c.json({ error: 'too_large', maxBytes: MAX_SEND_BYTES }, 413);

    const id = newId('att');
    const key = r2UploadKey(c.var.user.id, id);
    await c.env.MAIL_STORE.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    });
    await c.var.db.prepare(
      `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'attachment', ?, ?)`,
    )
      .bind(id, c.var.user.id, file.name || 'attachment', file.type || 'application/octet-stream', file.size, key, Date.now())
      .run();
    return c.json({ id, filename: file.name, sizeBytes: file.size, mimeType: file.type });
  });

  /* F7.2：取回 share_target 暫存的 compose payload（session-gated、單次）。KV key 綁 userId → 跨人隔離。 */
  app.get('/share-target/:token', async (c) => {
    const token = c.req.param('token');
    if (!/^[a-f0-9]{8,64}$/.test(token)) return c.json({ error: 'bad_request' }, 400);
    const key = `share:${c.var.user.id}:${token}`;
    const raw = await c.env.KV.get(key);
    if (!raw) return c.json({ error: 'not_found' }, 404);
    await c.env.KV.delete(key); // 單次：取回即作廢
    try {
      return c.json(JSON.parse(raw) as { subject: string; body: string; attachments: unknown[] });
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
  });

  /* ---------- F7.6：MBOX/EML 一次性匯入舊信 ---------- */
  const IMPORT_MAX_BYTES = 25 * 1024 * 1024; // mbox 上傳上限（控背景處理量；超大檔分次匯入）
  app.post('/import/mbox', async (c) => {
    // 先用 Content-Length 擋超大 body（在 parseBody 把整包緩衝進記憶體之前），避免 OOM。
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > IMPORT_MAX_BYTES + 1024 * 1024) return c.json({ error: 'too_large', maxBytes: IMPORT_MAX_BYTES }, 413);
    // 同時只允許一個進行中的匯入（防並發灌入 + 進度顯示單純）。
    const active = await c.var.db.prepare(
      `SELECT 1 FROM import_jobs WHERE user_id = ? AND status IN ('pending','running') LIMIT 1`,
    )
      .bind(c.var.user.id)
      .first();
    if (active) return c.json({ error: 'import_in_progress' }, 409);
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'bad_request' }, 400);
    if (file.size === 0) return c.json({ error: 'empty' }, 400);
    if (file.size > IMPORT_MAX_BYTES) return c.json({ error: 'too_large', maxBytes: IMPORT_MAX_BYTES }, 413);
    const jobId = newId('imp');
    const r2Key = `import/${c.var.user.id}/${jobId}`;
    await c.env.MAIL_STORE.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: 'application/mbox' } });
    const now = Date.now();
    await c.var.db.prepare(
      `INSERT INTO import_jobs (id, user_id, r2_key, filename, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(jobId, c.var.user.id, r2Key, file.name || 'import.mbox', now, now)
      .run();
    await c.env.INGEST_QUEUE.send({ kind: 'import-mbox', jobId, userId: c.var.user.id, offset: 0 }); // 背景分批匯入
    return c.json({ jobId });
  });

  // 匯入進度（前端輪詢）
  app.get('/import/jobs', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, filename, total, done, skipped, failed, status, created_at
       FROM import_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; filename: string; total: number; done: number; skipped: number; failed: number; status: string; created_at: number }>();
    return c.json({ jobs: rows.results });
  });

  /* ---------- F7.7：建立訊息級加密連結（站方只存密文/salt/iv，無金鑰/無密碼/無明文） ---------- */
  const ENC_MAX_CT_LEN = 300 * 1024; // base64 密文長度上限
  app.post('/encrypted', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { subject?: string; ciphertext?: string; salt?: string; iv?: string; expiresDays?: number }
      | null;
    if (!body || typeof body.ciphertext !== 'string' || typeof body.salt !== 'string' || typeof body.iv !== 'string') {
      return c.json({ error: 'bad_request' }, 400);
    }
    if (body.ciphertext.length > ENC_MAX_CT_LEN) return c.json({ error: 'too_large' }, 413);
    const b64 = /^[A-Za-z0-9+/=]+$/;
    if (!b64.test(body.ciphertext) || !b64.test(body.salt) || !b64.test(body.iv)) return c.json({ error: 'bad_request' }, 400);
    const days = Math.min(Math.max(Math.round(body.expiresDays ?? 7), 1), 30); // 1–30 天
    const id = newId('enc');
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join(''); // 192-bit
    const now = Date.now();
    const expiresAt = now + days * 86_400_000;
    await c.var.db.prepare(
      `INSERT INTO encrypted_links (id, token, user_id, subject, ciphertext, salt, iv, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, token, c.var.user.id, (body.subject ?? '').slice(0, 200) || null, body.ciphertext, body.salt, body.iv, expiresAt, now)
      .run();
    return c.json({ token, url: `${new URL(c.req.url).origin}/e/${token}`, expiresAt });
  });

  /* ---------- 大附件轉連結：存 R2 + 公開下載連結（token + 7 天到期） ---------- */
  app.post('/share/upload', async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'bad_request' }, 400);
    if (file.size > SHARE_MAX_BYTES) return c.json({ error: 'too_large', maxBytes: SHARE_MAX_BYTES }, 413);

    const id = newId('shr');
    // 高熵不可猜 token（即下載能力憑證）：24 bytes hex = 192 bits。
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
    const key = r2ShareKey(c.var.user.id, id);
    const now = Date.now();
    const expiresAt = now + SHARE_TTL_MS;
    await c.env.MAIL_STORE.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    });
    await c.var.db.prepare(
      `INSERT INTO shared_files (id, token, user_id, filename, mime_type, size_bytes, r2_key, download_count, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(id, token, c.var.user.id, file.name || 'file', file.type || 'application/octet-stream', file.size, key, expiresAt, now)
      .run();
    const url = `${new URL(c.req.url).origin}/dl/${token}`;
    return c.json({ token, url, filename: file.name || 'file', sizeBytes: file.size, expiresAt });
  });

  // F4.6b：使用者自己的分享連結清單（儲存管理頁用）。
  app.get('/share', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, token, filename, size_bytes, download_count, expires_at FROM shared_files WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; token: string; filename: string; size_bytes: number; download_count: number; expires_at: number }>();
    const origin = new URL(c.req.url).origin;
    return c.json({
      shares: rows.results.map((r) => ({
        id: r.id,
        filename: r.filename,
        sizeBytes: r.size_bytes,
        downloadCount: r.download_count,
        expiresAt: r.expires_at,
        url: `${origin}/dl/${r.token}`,
      })),
    });
  });

  // F4.6b：一鍵延長分享連結（延一個 TTL；總壽命上限 90 天；已過期不可延）。
  app.post('/share/:id/extend', async (c) => {
    const id = c.req.param('id');
    const row = await c.var.db.prepare(`SELECT expires_at, created_at FROM shared_files WHERE id = ? AND user_id = ?`)
      .bind(id, c.var.user.id)
      .first<{ expires_at: number; created_at: number }>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.expires_at <= Date.now()) return c.json({ error: 'expired' }, 410); // 已過期（待 sweep 清）不可延長
    // 延一個 TTL，但總壽命上限＝建立起 90 天（防無限延長）。
    const newExp = Math.min(row.expires_at + SHARE_TTL_MS, row.created_at + 90 * 86_400_000);
    if (newExp <= row.expires_at) return c.json({ error: 'max_lifetime', expiresAt: row.expires_at }, 409); // 已達上限
    await c.var.db.prepare(`UPDATE shared_files SET expires_at = ?, expiry_reminded = 0 WHERE id = ? AND user_id = ?`)
      .bind(newExp, id, c.var.user.id)
      .run();
    return c.json({ ok: true, expiresAt: newExp });
  });

  /** 移除 staged 附件（已綁定訊息的不可刪） */
  app.delete('/attachments/:id', async (c) => {
    const id = c.req.param('id');
    const att = await c.var.db.prepare(
      `SELECT r2_key FROM attachments WHERE id = ? AND user_id = ? AND message_id IS NULL`,
    )
      .bind(id, c.var.user.id)
      .first<{ r2_key: string }>();
    if (!att) return c.json({ error: 'not_found' }, 404);
    // E2 + 第8輪：被「尚未終結」的寄送引用的附件不可刪——scheduled/sending（檢查後投遞前的窗口）
    // 以及 review（外送待裁決，外部可能已送、附件仍可能被 resolve resend/sent 重跑用到）。
    // 否則消費者會撞到附件消失：混合寄送可能外部已寄內部永久收不到，或 review 解析時丟失本地寄件備份。
    // 附件 id 以 JSON 陣列存在 payload。
    const inUse = await c.var.db.prepare(
      `SELECT 1 FROM send_queue WHERE user_id = ? AND payload LIKE ?
       AND (status IN ('scheduled', 'sending') OR (${REVIEW_SQL})) LIMIT 1`,
    )
      .bind(c.var.user.id, `%"${id}"%`)
      .first();
    if (inUse) return c.json({ error: 'attachment_in_use' }, 409);
    await c.env.MAIL_STORE.delete(att.r2_key);
    await c.var.db.prepare(`DELETE FROM attachments WHERE id = ?`).bind(id).run();
    return c.json({ ok: true });
  });

  return app;
}
