// 站內直送：@miseroda.com 使用者之間的信不繞 SMTP，直接落到收件人信箱
// （即時、零寄信額度、不依賴 Email Routing 規則）+ 假期自動回覆 hook
import { newId } from '../lib/ids';
import { r2AttKey, r2HtmlKey } from '../lib/keys';
import { inboxUnreadCount, notifyUser } from '../lib/notify';
import { applyRules } from './rulesEngine';
import { enqueueForwards } from './forward';
import { bumpThread, resolveThread } from './threading';
import type { SendJob } from '../jobs/types';

export interface InternalAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** 來源 R2 key（寄件者的 staged 物件）；投遞時複製成收件人自有的物件 */
  r2Key: string;
}

export interface InternalDeliveryArgs {
  recipientUserId: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  subject: string;
  html: string; // 已消毒（寄件路徑統一在 send route 消毒）
  text: string;
  messageIdHeader: string;
  inReplyTo: string | null;
  references: string | null;
  attachments: InternalAttachment[];
  timestamp: number;
  /** F4.1b：此封是規則自動轉寄產生的站內投遞 → 落地時不再觸發轉寄規則（斷迴圈）。 */
  forwarded?: boolean;
}

/** 內部投遞遇來源附件遺失時拋出 → 讓整封 fail-closed（不靜默漏附件 C2） */
export class AttachmentSourceMissingError extends Error {
  constructor(public attachmentId: string) {
    super(`attachment_source_missing:${attachmentId}`);
  }
}

export async function deliverInternal(env: Env, args: InternalDeliveryArgs): Promise<string> {
  const snippet = args.text.replace(/\s+/g, ' ').trim().slice(0, 140);

  // 冪等鍵：messageIdHeader 由 send_queue.id 衍生，重寄時穩定。
  // 已投遞過 → 不重插訊息/不重複附件，但下方收尾步驟全部冪等重跑，
  // 補上第一次可能因中途失敗而漏掉的索引/規則/通知（C3）。
  const existing = await env.DB.prepare(
    `SELECT id, thread_id, folder FROM messages WHERE user_id = ? AND message_id_header = ?`,
  )
    .bind(args.recipientUserId, args.messageIdHeader)
    .first<{ id: string; thread_id: string; folder: string }>();

  let messageId: string;
  let threadId: string;
  // 收尾重跑時規則引擎要看「目前實際資料夾」，新插入則為 inbox。
  // 否則重寄會以寫死的 inbox 重新觸發 move 規則，覆蓋收件人手動搬移的結果（D3）。
  let currentFolder: string;

  if (existing) {
    messageId = existing.id;
    threadId = existing.thread_id;
    currentFolder = existing.folder;
  } else {
    messageId = newId('msg');
    threadId = await resolveThread(env, args.recipientUserId, {
      inReplyTo: args.inReplyTo,
      references: args.references,
      subject: args.subject,
      timestamp: args.timestamp,
    });
    // 靜音對話串：站內回覆到 muted 串也跳過收件匣（進封存）並標已讀
    const muted =
      (await env.DB.prepare(`SELECT muted FROM threads WHERE id = ?`).bind(threadId).first<{ muted: number }>())?.muted === 1;
    currentFolder = muted ? 'archive' : 'inbox';

    const htmlKey = r2HtmlKey(args.recipientUserId, messageId);
    await env.MAIL_STORE.put(htmlKey, args.html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });

    // 附件：先複製成收件人自有的 R2 物件（不再與寄件者共用 key，F3）。
    // 來源遺失 → fail-closed 拋錯（C2）：呼叫端 markFailed，重寄時靠冪等鍵安全重跑。
    const attStmts: D1PreparedStatement[] = [];
    for (const att of args.attachments) {
      const src = await env.MAIL_STORE.get(att.r2Key);
      if (!src) throw new AttachmentSourceMissingError(att.r2Key);
      const attId = newId('att');
      const destKey = r2AttKey(args.recipientUserId, messageId, attId);
      await env.MAIL_STORE.put(destKey, await src.arrayBuffer(), {
        httpMetadata: { contentType: att.mimeType },
      });
      attStmts.push(
        env.DB.prepare(
          `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'attachment', ?, ?)`,
        ).bind(attId, messageId, args.recipientUserId, att.filename, att.mimeType, att.sizeBytes, destKey, args.timestamp),
      );
    }
    // has_attachments 依實際複製數（理論上全部成功，否則上面已拋錯）
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, user_id, thread_id, message_id_header, in_reply_to, references_header,
          direction, from_addr, from_name, to_addrs, cc_addrs, subject, snippet, r2_html_key,
          size_bytes, has_attachments, is_read, folder, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        messageId,
        args.recipientUserId,
        threadId,
        args.messageIdHeader,
        args.inReplyTo,
        args.references,
        args.fromAddr,
        args.fromName,
        JSON.stringify(args.toAddrs),
        JSON.stringify(args.ccAddrs),
        args.subject,
        snippet,
        htmlKey,
        new TextEncoder().encode(args.text).byteLength,
        attStmts.length ? 1 : 0,
        currentFolder === 'archive' ? 1 : 0,
        currentFolder,
        args.timestamp,
        args.timestamp,
      ),
      ...attStmts,
    ]);
  }

  /* ---- 以下收尾步驟全部冪等，dedup 重跑安全（C3）---- */
  await bumpThread(env, threadId, args.timestamp); // 重算 count，不重複計數

  // F4.1a：從已落地的列讀回 cc/附件/大小/信齡（first-insert 與去重重跑皆正確），讓站內信也能套用這些條件規則。
  const f41 = await env.DB.prepare(
    `SELECT cc_addrs, has_attachments, size_bytes, received_at FROM messages WHERE id = ? AND user_id = ?`,
  )
    .bind(messageId, args.recipientUserId)
    .first<{ cc_addrs: string | null; has_attachments: number | null; size_bytes: number | null; received_at: number | null }>();

  // 自動規則（站內信沒有 List-Unsubscribe）；folder 設固定值、標籤 INSERT OR IGNORE → 冪等
  const ruleResult = await applyRules(
    env,
    {
      id: messageId,
      user_id: args.recipientUserId,
      from_addr: args.fromAddr,
      from_name: args.fromName,
      subject: args.subject,
      folder: currentFolder, // 非 inbox（使用者已搬移）→ 規則不再 move，避免覆蓋
      to_addrs: JSON.stringify(args.toAddrs),
      cc_addrs: f41?.cc_addrs ?? undefined,
      has_attachments: f41?.has_attachments ?? undefined,
      size_bytes: f41?.size_bytes ?? undefined,
      received_at: f41?.received_at ?? undefined,
    },
    // 去重重跑時不再強制 star/markRead。
    // F2.8a：刻意「不」傳 authVerdict——站內直送無外部 DMARC/SPF/DKIM（auth_verdict=NULL）。
    // 若傳 'none'，使用者一條寬鬆的「未驗證→封存/垃圾桶」規則就會「自動」掃掉受信任的站內/家人信（鎖人風險）。
    // 故站內信落地時 authVerdict 條件一律不成立（保守）；既有信「套用規則」走 runRuleOnExisting 有預覽可審，差異可接受。
    // F4.1b：isForwarded=true（此封本身是規則自動轉寄產生的站內投遞）→ 不再收集 forward 目標（斷站內迴圈）。
    { hasListUnsubscribe: false, firstInsert: !existing, isForwarded: args.forwarded },
  );

  // F4.1b：命中轉寄規則 → 以本人身分排程外寄（去重後 at-most-once）。只在有目標時才查 userEmail（常路徑零成本）。
  if (ruleResult.forwardTargets.length) {
    const ue = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`)
      .bind(args.recipientUserId)
      .first<{ email: string }>();
    if (ue) {
      await enqueueForwards(
        env,
        {
          userId: args.recipientUserId,
          userEmail: ue.email,
          messageId,
          fromAddr: args.fromAddr,
          fromName: args.fromName,
          subject: args.subject,
          html: args.html,
          text: args.text,
        },
        ruleResult.forwardTargets,
      );
    }
  }

  // FTS（INSERT OR IGNORE + INSERT OR REPLACE → 冪等）
  await env.DB_FTS.prepare(`INSERT OR IGNORE INTO msg_map (message_id, user_id) VALUES (?, ?)`)
    .bind(messageId, args.recipientUserId)
    .run();
  const mapRow = await env.DB_FTS.prepare(`SELECT fts_rowid FROM msg_map WHERE message_id = ?`)
    .bind(messageId)
    .first<{ fts_rowid: number }>();
  if (mapRow) {
    await env.DB_FTS.prepare(
      `INSERT OR REPLACE INTO messages_fts (rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(mapRow.fts_rowid, args.subject, `${args.fromName} ${args.fromAddr}`, snippet, args.text.slice(0, 100_000))
      .run();
  }

  // 假期自動回覆（KV 4 天節流 → 冪等，重跑不會重發）
  await maybeVacationReply(env, {
    recipientUserId: args.recipientUserId,
    senderAddr: args.fromAddr,
    subject: args.subject,
    isBulk: false,
  });

  // 即時通知：WS 一律刷新；系統推播只給留在收件匣的信（規則歸檔不吵人）
  const after = await env.DB.prepare(`SELECT folder FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<{ folder: string }>();
  await notifyUser(env, args.recipientUserId, {
    type: 'new-mail',
    push:
      after?.folder === 'inbox'
        ? {
            title: args.fromName || args.fromAddr,
            body: args.subject || '(無主旨)',
            url: `/#msg-${messageId}`,
            id: messageId, // SW 通知 tag（不互相覆蓋）+ 封存/已讀動作目標
            unread: await inboxUnreadCount(env, args.recipientUserId), // SW 背景設 OS 角標
          }
        : undefined,
  });

  return messageId;
}

/* ================= 假期自動回覆 ================= */

const NOREPLY_RE = /^(no-?reply|noreply|mailer-daemon|postmaster|bounce|bounces?[+_-])/i;

export interface VacationCheckArgs {
  recipientUserId: string;
  senderAddr: string;
  subject: string;
  /** 清單信/自動信（List-Unsubscribe / Auto-Submitted / Precedence: bulk）不回 */
  isBulk: boolean;
}

/** 收件人開啟假期回覆時，透過正常寄信管線回一封（每寄件人 4 天最多一次） */
export async function maybeVacationReply(env: Env, args: VacationCheckArgs): Promise<void> {
  if (args.isBulk) return;
  const sender = args.senderAddr.toLowerCase();
  if (NOREPLY_RE.test(sender.split('@')[0] ?? '') || sender === 'digest@miseroda.com') return;

  const row = await env.DB.prepare(
    `SELECT u.email, us.prefs FROM users u JOIN user_settings us ON us.user_id = u.id WHERE u.id = ?`,
  )
    .bind(args.recipientUserId)
    .first<{ email: string; prefs: string }>();
  if (!row || sender === row.email.toLowerCase()) return;

  let vacation: { on?: boolean; until?: number | null; body?: string } = {};
  try {
    vacation = (JSON.parse(row.prefs) as { vacation?: typeof vacation }).vacation ?? {};
  } catch {
    return;
  }
  if (!vacation.on || !vacation.body?.trim()) return;
  if (vacation.until && Date.now() > vacation.until) return;

  // 每寄件人 4 天最多回一次
  const throttleKey = `vac:${args.recipientUserId}:${sender}`;
  if (await env.KV.get(throttleKey)) return;
  await env.KV.put(throttleKey, '1', { expirationTtl: 4 * 86400 });

  const id = newId('snd');
  const payload = {
    to: [args.senderAddr],
    cc: [],
    bcc: [],
    subject: `自動回覆：${args.subject || ''}`.slice(0, 990),
    text: vacation.body,
    attachmentIds: [],
    inReplyTo: null,
    references: null,
    replyToMessageId: null,
    fromAlias: null,
  };
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at)
     VALUES (?, ?, ?, 'scheduled', ?, ?)`,
  )
    .bind(id, args.recipientUserId, JSON.stringify(payload), now, now)
    .run();
  await env.SEND_QUEUE.send({ kind: 'send', sendQueueId: id } satisfies SendJob);
}
