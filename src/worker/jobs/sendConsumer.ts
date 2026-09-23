// 寄信 consumer：原子 claim 防雙寄 → 收件人分流（站內直送 / 外部 Email Service）→ 寄件備份 + FTS
import { audit } from '../lib/audit';
import { newId } from '../lib/ids';
import { logError } from '../lib/logError';
import { r2AttKey, r2HtmlKey } from '../lib/keys';
import { notifyUser } from '../lib/notify';
import { textToHtml } from '../email/sanitize';
import { bumpThread, resolveThread } from '../email/threading';
import { AttachmentSourceMissingError, deliverInternal, type InternalAttachment } from '../email/deliver';
import { isAllowedSendIdentity, shouldTrackReply, type SendPayload } from '../api/send';
import type { SendJob } from './types';

/* 外送錯誤碼分類（依 Cloudflare Email Sending Workers API 錯誤碼表，準則＝「provider 是否確定未接受」）：
 *
 *   TRANSIENT_REJECTION  確定未接受、值得自動重試（限流被擋下、根本沒收）
 *     → 回滾 external_state=NULL，還原 scheduled 丟回 queue 自動重試（乾淨重送、不會重複）
 *   PERMANENT_REJECTION  確定未接受、重試也無用（同步驗證/額度/標頭錯誤，送出前就被拒）
 *     → 回滾 external_state=NULL，標 failed（可修正後手動重寄，不卡 review）
 *   其餘（E_INTERNAL_SERVER_ERROR / E_DELIVERY_FAILED / E_UNKNOWN / 逾時 / 未列舉碼）
 *     = 結果未定：provider「可能已接受」→ 絕不回滾、絕不自動重送 → 保留 attempting → 轉「待裁決」。
 *
 * 安全預設：任何不在以下兩個「確定未接受」集合中的碼一律落到「結果未定」分支（永不自動重複外送）。
 */
const TRANSIENT_REJECTION = new Set(['E_RATE_LIMIT_EXCEEDED']);
const PERMANENT_REJECTION = new Set([
  'E_VALIDATION_ERROR',
  'E_FIELD_MISSING',
  'E_TOO_MANY_RECIPIENTS',
  'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_CONTENT_TOO_LARGE',
  'E_DAILY_LIMIT_EXCEEDED',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
]);

interface SendQueueRow {
  id: string;
  user_id: string;
  payload: string;
  status: string;
  scheduled_at: number;
  attempts: number;
  external_sent_at: number | null;
  external_state: 'attempting' | 'accepted' | null;
}

export async function processSendJob(env: Env, job: SendJob): Promise<void> {
  const row = await env.DB.prepare(`SELECT * FROM send_queue WHERE id = ?`)
    .bind(job.sendQueueId)
    .first<SendQueueRow>();
  if (!row || row.status !== 'scheduled') return; // 已取消 / 已寄出 / 不存在

  // 原子 claim（佇列至少一次投遞 → 只有一個 worker 能翻成 sending）
  const claim = await env.DB.prepare(
    `UPDATE send_queue SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'scheduled'`,
  )
    .bind(job.sendQueueId)
    .run();
  if (!(claim.meta.changes ?? 0)) return;

  const payload = JSON.parse(row.payload) as SendPayload;
  const user = await env.DB.prepare(`SELECT id, email, display_name, status FROM users WHERE id = ?`)
    .bind(row.user_id)
    .first<{ id: string; email: string; display_name: string; status: string }>();
  if (!user) {
    await markFailed(env, row.id, 'user_missing');
    return;
  }
  // 停用即撤銷未消化的寄送：排入當下有效的授權，到消費這一刻可能已被 admin 收回
  // （停用會作廢 session／信任裝置，但 send_queue 列不受影響，undo 窗口／排程最長 30 天）。
  // 此處與本檔其他信任判斷（站內收件人 status='active'、別名 disabled=0）一致，逐列再確認一次寄件身分仍有效。
  // 標 failed（非 canceled）：信不銷毀、external_state 維持 NULL → 帳號重新啟用後可自 outbox 重寄。
  if (user.status !== 'active') {
    await markFailed(env, row.id, 'user_disabled');
    return;
  }

  // Send-as 寄件身分：已驗證的 fromAlias（本人 canonical/+tag/擁有的乾淨別名），否則 canonical email。
  // 高風險寄送路徑：payload 來自 D1、理論上已於 send route 驗過，但這裡再把關一次（不信任、防呆），不合法即退回 canonical。
  let fromEmail = user.email;
  if (payload.fromAlias) {
    const owned = await env.DB.prepare(`SELECT address FROM aliases WHERE user_id = ? AND disabled = 0`)
      .bind(user.id)
      .all<{ address: string }>();
    if (isAllowedSendIdentity(payload.fromAlias, user.email, owned.results.map((r) => r.address))) {
      fromEmail = payload.fromAlias;
    }
  }
  const fromName = user.display_name || fromEmail;

  /* ---- 收件人分流：站內使用者直送，外部走 Email Service ---- */
  const domain = `@${env.MAIL_DOMAIN.toLowerCase()}`;
  const allRecipients = [...new Set([...payload.to, ...payload.cc, ...payload.bcc].map((a) => a.trim().toLowerCase()))];
  const maybeInternal = allRecipients.filter((a) => a.endsWith(domain));
  // 域內地址 → 擁有者 user：直接 user email，或指派給 active 使用者的別名（與 ingest 路由一致）。
  // 解析不到的（含 +tag 變體）視為外部，照舊走 Email Service（再由 Email Routing/ingest 收尾）。
  const ownerByAddr = new Map<string, { id: string; email: string }>();
  if (maybeInternal.length) {
    const ph = maybeInternal.map(() => '?').join(',');
    const us = await env.DB.prepare(
      `SELECT id, email FROM users WHERE status = 'active' AND email IN (${ph})`,
    )
      .bind(...maybeInternal)
      .all<{ id: string; email: string }>();
    for (const u of us.results) ownerByAddr.set(u.email, { id: u.id, email: u.email });
    const al = await env.DB.prepare(
      `SELECT a.address, u.id, u.email FROM aliases a JOIN users u ON u.id = a.user_id
       WHERE u.status = 'active' AND a.address IN (${ph})`,
    )
      .bind(...maybeInternal)
      .all<{ address: string; id: string; email: string }>();
    for (const a of al.results) if (!ownerByAddr.has(a.address)) ownerByAddr.set(a.address, { id: a.id, email: a.email });
  }
  const internalSet = new Set(ownerByAddr.keys());
  // 內送對象依擁有者 user 去重（user email 與其別名同時在收件人時只送一份）。
  const internalUsers = [...new Map([...ownerByAddr.values()].map((u) => [u.id, u])).values()];
  const externalTo = payload.to.filter((a) => !internalSet.has(a.trim().toLowerCase()));
  const externalCc = payload.cc.filter((a) => !internalSet.has(a.trim().toLowerCase()));
  const externalBcc = payload.bcc.filter((a) => !internalSet.has(a.trim().toLowerCase()));
  const hasExternal = externalTo.length + externalCc.length + externalBcc.length > 0;

  // 載入 staged 附件
  const attRows = payload.attachmentIds.length
    ? (
        await env.DB.prepare(
          `SELECT id, filename, mime_type, size_bytes, r2_key FROM attachments
           WHERE id IN (${payload.attachmentIds.map(() => '?').join(',')}) AND user_id = ?`,
        )
          .bind(...payload.attachmentIds, user.id)
          .all<{ id: string; filename: string; mime_type: string; size_bytes: number; r2_key: string }>()
      ).results
    : [];

  // D2：附件完整性守門。staged 附件在寄送完成前都是 message_id NULL，可在排程/undo 窗口被刪除；
  // IN 查詢會靜默回傳子集。任一被請求的附件不在 → 整封 fail-closed，不寄出漏附件的信。
  // （/messages/send 在排入時就檢過一次，但排入後到消費前仍有刪除窗口，故消費端再檢一次。）
  if (attRows.length !== payload.attachmentIds.length) {
    const present = new Set(attRows.map((a) => a.id));
    const missing = payload.attachmentIds.filter((id) => !present.has(id));
    await markFailed(env, row.id, `attachment_missing:${missing.join(',')}`);
    return;
  }

  const headers: Record<string, string> = {};
  if (payload.inReplyTo) headers['In-Reply-To'] = payload.inReplyTo;
  if (payload.references) headers['References'] = payload.references;
  // F4.1b：外寄轉寄信打標頭 → 落地時不再觸發轉寄規則（斷迴圈）。
  // F11：值＝enqueueForwards 核發的隨機 marker（收信端查 forward_markers 才採信）。
  // 舊佇列列（本次上線前排入、還沒消化的）沒有 marker → 退回舊的 '1'：收信端不採信，
  // 該封扇回會多轉一代，但第二代起就帶得動 marker，迴圈仍然有界。
  if (payload.forwarded) headers['X-Miseroda-Forwarded'] = payload.forwardMarker ?? '1';

  // 內容：富文本（已在 send route 消毒）優先，否則純文字轉 HTML
  const html = payload.html?.trim() ? payload.html : textToHtml(payload.text);
  // 合成 Message-ID：寄件備份與站內收件副本一致，確保雙向回覆 threading
  const messageIdHeader = `<${row.id}@${env.MAIL_DOMAIN}>`;

  /* ---- 外部寄送：external_state 三態機（終結重複/漏送的根因） ----
   * provider 無冪等鍵（Email Service 不允許自訂 Message-ID），送出與其持久化無法原子化，
   * 故用一個與 status 解耦的外送階段標記，讓「結果未定」的信永不被自動重送：
   *   accepted   → 已確定送出，跳過外送、只重跑本地收尾（冪等）
   *   attempting → 前次外送結果未定 → 不重送、不標已寄 → 轉「待裁決」交使用者決定
   *   null       → 全新：送出「前」先寫 attempting，送出成功後寫 accepted，provider 確定拒收則回滾 null
   *
   * 相容守門：0007 之前用 external_sent_at（0006）守門，升級殘留列可能 external_sent_at 有值但
   * external_state 仍 NULL（0008 已回填，這裡再加一層）→ external_sent_at 有值一律視為已接受，
   * 確保任何舊列在回填前/部署窗口也不會被重送。
   *
   * 內外腿解耦：外送只「決定整封最終 status」，不再 early-return 餓死站內腿。
   *   externalReview → 結果未定，整封轉 review（status='failed'+attempting+external_uncertain）
   *   externalFailed → 永久拒收，整封 status='failed'（external_state 已回滾 NULL）
   * 兩者皆 falsy ⇒ 外送成功 / 無外部 → 整封 sent。站內投遞 + 寄件備份一律照常完成（除非純外部退信）。
   */
  let externalReview = false;
  let externalFailed: string | null = null;

  const alreadyAccepted = row.external_state === 'accepted' || row.external_sent_at != null;
  if (hasExternal && !alreadyAccepted) {
    if (row.external_state === 'attempting') {
      // 前次已嘗試但結果未定 → 轉「待裁決」；本地腿仍照常完成（不再 early-return 餓死站內收件人）。
      externalReview = true;
      await audit(env.DB, {
        userId: user.id,
        action: 'message.send.uncertain',
        targetType: 'send_queue',
        targetId: row.id,
        meta: { to: payload.to },
      });
    } else {
      const attachments: { content: ArrayBuffer; filename: string; type: string; disposition: 'attachment' }[] = [];
      let missingAttachment = false;
      for (const a of attRows) {
        const obj = await env.MAIL_STORE.get(a.r2_key);
        if (!obj) {
          // 附件來源遺失 → fail-closed 中止整封（內外腿都不投遞缺附件的信）。
          await markFailed(env, row.id, `attachment_missing:${a.id}`);
          missingAttachment = true;
          break;
        }
        attachments.push({
          content: await obj.arrayBuffer(),
          filename: a.filename,
          type: a.mime_type,
          disposition: 'attachment',
        });
      }
      if (missingAttachment) return;

      // Email Service 要求 to 非空：全內部 to + 外部 cc 的邊角 → 把外部 cc 升為 to
      const sendTo = externalTo.length ? externalTo : externalCc;
      const sendCc = externalTo.length ? externalCc : [];

      // 送出「前」durable 標記 attempting：此後不論如何崩潰，重寄都不會自動再送外部。
      await env.DB.prepare(`UPDATE send_queue SET external_state = 'attempting' WHERE id = ?`).bind(row.id).run();

      // 只把 provider 呼叫本身包在 try 內：送出失敗 vs 送出成功後的持久化失敗要分開處理。
      let accepted = false;
      try {
        await env.SEND_EMAIL.send({
          to: sendTo,
          ...(sendCc.length ? { cc: sendCc } : {}),
          ...(externalBcc.length ? { bcc: externalBcc } : {}),
          from: { email: fromEmail, name: fromName },
          subject: payload.subject || '（無主旨）',
          text: payload.text,
          html,
          ...(attachments.length ? { attachments } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
        });
        accepted = true;
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'E_UNKNOWN';
        const message = (err as Error).message ?? String(err);

        // 關鍵：回滾 external_state 只在「provider 確定未接受」的分支內做；
        // 其餘（可能已接受）絕不回滾、絕不自動重送，保留 attempting 交使用者裁決。
        if (TRANSIENT_REJECTION.has(code)) {
          // 確定未接受、可重試（限流）→ 回滾 attempting，還原 scheduled 丟回 queue 自動重試。
          // 整封 wholesale 重試（throw）；站內腿留待重試時冪等補上，不在此處投遞。
          await env.DB.prepare(`UPDATE send_queue SET external_state = NULL WHERE id = ?`).bind(row.id).run();
          await env.DB.prepare(
            `UPDATE send_queue SET status = 'scheduled', last_error = ? WHERE id = ? AND status = 'sending'`,
          )
            .bind(`${code}: ${message}`, row.id)
            .run();
          throw err;
        } else if (PERMANENT_REJECTION.has(code)) {
          // 確定未接受、重試無用（驗證/額度/標頭）→ 回滾 attempting，記永久失敗（最終 status 於下方統一設定）。
          await env.DB.prepare(`UPDATE send_queue SET external_state = NULL WHERE id = ?`).bind(row.id).run();
          externalFailed = `${code}: ${message}`;
          await audit(env.DB, {
            userId: user.id,
            action: 'message.send.failed',
            targetType: 'send_queue',
            targetId: row.id,
            meta: { code, to: payload.to },
          });
        } else {
          // 結果未定（E_INTERNAL_SERVER_ERROR / E_DELIVERY_FAILED / E_UNKNOWN / 逾時 / 未列舉）：
          // provider 可能已接受 → 保留 external_state='attempting'（不回滾）→ 轉「待裁決」，絕不自動重送。
          externalReview = true;
          await audit(env.DB, {
            userId: user.id,
            action: 'message.send.uncertain',
            targetType: 'send_queue',
            targetId: row.id,
            meta: { code, to: payload.to },
          });
        }
      }

      // provider 已接受 → 寫 accepted（帶小重試；即使最終寫不成，external_state 仍是 attempting，
      // 後續若失敗，重寄會轉「待裁決」而非重送 → 永不重複）。
      if (accepted) await persistAccepted(env, row.id);
    }
  }

  /* ---- 本地腿：站內投遞 + 寄件備份（與外送結果解耦，恆冪等去重） ----
   * 內外腿解耦只為「外部失敗時別餓死站內收件人」。純外部信沒有站內收件人可餓死，本地腿對它唯一做的
   * 就是寫寄件備份——因此純外部信在外部「沒乾淨成功」（永久退信 externalFailed 或 結果未定 externalReview）
   * 時跳過本地腿，避免在外部結果確認前就留下一封看似正常寄出的 Sent 幻影信（同時被 outbox 標 review
   * 又出現在 Sent/搜尋/對話串/檔案庫，且 discard 後成為孤兒）。使用者裁決 resolve 'sent'/'resend' 成功
   * 後重跑時才寫 Sent 副本（externalReview 屆時為 false）。
   * 有站內收件人的混合信一律完成本地腿（站內確實收到 → 寄件備份合法），外送卡關不再餓死站內腿。 */
  const hasInternal = internalUsers.length > 0;
  const skipLocal = !hasInternal && (externalFailed != null || externalReview);

  const now = Date.now();
  let sentMessageId: string | null = null;
  if (!skipLocal) {
    const internalAtts: InternalAttachment[] = attRows.map((a) => ({
      filename: a.filename,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      r2Key: a.r2_key,
    }));
    try {
      for (const recipient of internalUsers) {
        await deliverInternal(env, {
          recipientUserId: recipient.id,
          fromAddr: fromEmail,
          fromName,
          toAddrs: payload.to,
          ccAddrs: payload.cc,
          subject: payload.subject,
          html,
          text: payload.text,
          messageIdHeader,
          inReplyTo: payload.inReplyTo,
          references: payload.references,
          attachments: internalAtts,
          timestamp: now,
          forwarded: payload.forwarded, // F4.1b：站內投遞帶轉寄旗標 → 落地不再觸發轉寄規則（斷站內迴圈）
        });
      }
    } catch (err) {
      // C2：附件來源遺失 → fail-closed，立即標記失敗（不靜默漏附件、不等 15 分鐘 sweeper）。
      // external_state='accepted' → 使用者重寄不會重發外部信，內部靠 message_id_header 去重。
      if (err instanceof AttachmentSourceMissingError) {
        await markFailed(env, row.id, err.message);
        return;
      }
      throw err; // 其他錯誤維持原本 queue retry 行為
    }

    /* ---- 落地寄件備份（dedup by message_id_header；重跑只認既有列、不重複寫） ---- */
    const existingSent = await env.DB.prepare(
      `SELECT id FROM messages WHERE user_id = ? AND message_id_header = ? AND direction = 'outbound'`,
    )
      .bind(user.id, messageIdHeader)
      .first<{ id: string }>();
    if (existingSent) {
      sentMessageId = existingSent.id;
    } else {
      const messageId = newId('msg');
      const threadId = await resolveThread(env, user.id, {
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        subject: payload.subject,
        timestamp: now,
      });
      await env.MAIL_STORE.put(r2HtmlKey(user.id, messageId), html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      });
      const snippet = payload.text.replace(/\s+/g, ' ').trim().slice(0, 140);

      const stmts = [
        env.DB.prepare(
          `INSERT INTO messages (id, user_id, thread_id, message_id_header, in_reply_to, references_header,
            direction, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, subject, snippet,
            r2_html_key, size_bytes, has_attachments, is_read, folder, received_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'sent', ?, ?)`,
        ).bind(
          messageId,
          user.id,
          threadId,
          messageIdHeader,
          payload.inReplyTo,
          payload.references,
          fromEmail,
          fromName,
          JSON.stringify(payload.to),
          JSON.stringify(payload.cc),
          JSON.stringify(payload.bcc),
          payload.subject,
          snippet,
          r2HtmlKey(user.id, messageId),
          new TextEncoder().encode(payload.text).byteLength + attRows.reduce((s, a) => s + a.size_bytes, 0),
          attRows.length ? 1 : 0,
          now,
          now,
        ),
      ];
      if (attRows.length) {
        stmts.push(
          env.DB.prepare(
            // 單向閂鎖：只綁未綁定（message_id IS NULL）的 staged 附件，任何寄送都不能奪走別封信
            // 已綁定的附件（防 re-parent / 跨信擁有權損毀）。此區塊在重跑時已由 message_id_header 去重整段跳過，
            // 故只在首次建立寄件備份時執行，屆時附件必為 NULL → 閂鎖不會擋下正當的首次綁定。
            `UPDATE attachments SET message_id = ? WHERE id IN (${attRows.map(() => '?').join(',')}) AND message_id IS NULL`,
          ).bind(messageId, ...attRows.map((a) => a.id)),
        );
      }
      await env.DB.batch(stmts);

      // 附件衝突收尾：上面以樂觀 attRows.length 寫 has_attachments，並用單向閂鎖（AND message_id IS NULL）綁定。
      // 在罕見的「同一 staged 附件被兩封 send 共用」競態下，先跑的那封會先綁走共用列，本封閂鎖落空 →
      // 本封 Sent 副本會少一份附件列（旗標卻說有）。信已正確投遞（附件投遞前已自 R2 緩衝/複製），
      // 這裡為「被搶走」的附件複製一份本封自有副本（鏡像 F3：複製 R2 物件 + 新 att 列），
      // 讓本封 Sent 副本擁有完整可下載的附件、旗標誠實——根源退掉「少報/多報」之爭。
      // 只在 !existingSent 內 → resolve-sent 重跑整段跳過；一般送出閂鎖全綁中 → 不進此分支；只在真衝突才複製。
      // 絕不 markFailed / 不重送（信已寄出）。來源 R2 物件遺失則容忍跳過，旗標誠實降為實際數。
      if (attRows.length) {
        const myBound = await env.DB.prepare(`SELECT id FROM attachments WHERE message_id = ?`)
          .bind(messageId)
          .all<{ id: string }>();
        const boundSet = new Set(myBound.results.map((r) => r.id));
        if (boundSet.size !== attRows.length) {
          for (const a of attRows) {
            if (boundSet.has(a.id)) continue; // 已綁到本封 → 不動
            const src = await env.MAIL_STORE.get(a.r2_key);
            if (!src) continue; // 來源遺失 → 容忍跳過（旗標下方依實際數誠實設定）
            const attId = newId('att');
            const destKey = r2AttKey(user.id, messageId, attId);
            await env.MAIL_STORE.put(destKey, await src.arrayBuffer(), { httpMetadata: { contentType: a.mime_type } });
            await env.DB.prepare(
              `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'attachment', ?, ?)`,
            )
              .bind(attId, messageId, user.id, a.filename, a.mime_type, a.size_bytes, destKey, now)
              .run();
          }
          // 依最終實際綁定數誠實設定旗標（複製成功則補齊為 1；若來源全遺失則為 0）
          const finalCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?`)
            .bind(messageId)
            .first<{ n: number }>();
          await env.DB.prepare(`UPDATE messages SET has_attachments = ? WHERE id = ?`)
            .bind((finalCount?.n ?? 0) ? 1 : 0, messageId)
            .run();
        }
      }
      await bumpThread(env, threadId, now);

      // FTS 索引寄出信
      await env.DB_FTS.prepare(`INSERT OR IGNORE INTO msg_map (message_id, user_id) VALUES (?, ?)`)
        .bind(messageId, user.id)
        .run();
      const mapRow = await env.DB_FTS.prepare(`SELECT fts_rowid FROM msg_map WHERE message_id = ?`)
        .bind(messageId)
        .first<{ fts_rowid: number }>();
      if (mapRow) {
        await env.DB_FTS.prepare(
          `INSERT OR REPLACE INTO messages_fts (rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(mapRow.fts_rowid, payload.subject, fromEmail, snippet, payload.text.slice(0, 100_000))
          .run();
      }
      sentMessageId = messageId;
    }
  }

  /* ---- 整封最終 status（單一真實來源，反映外送結果） ----
   * 注意：寄件備份的訊息列已於上方落地，但 status 在此才設定，使「外送 review/failed 但站內已送達」
   * 的混合信能正確顯示（outbox review / failed），而非被本地腿成功翻成 sent。 */
  if (externalReview) {
    // 保留 external_state='attempting' → outbox 'review'；本地腿（若有）已完成。
    await markFailed(env, row.id, 'external_uncertain');
  } else if (externalFailed != null) {
    await markFailed(env, row.id, externalFailed);
  } else {
    await env.DB.prepare(`UPDATE send_queue SET status = 'sent', sent_at = ?, message_id = ? WHERE id = ?`)
      .bind(now, sentMessageId, row.id)
      .run();
    await audit(env.DB, {
      userId: user.id,
      action: 'message.send',
      targetType: 'message',
      targetId: sentMessageId ?? row.id,
      meta: { to: payload.to, subject: payload.subject, internal: internalUsers.length, external: hasExternal },
    });
    // F2.3：寄出含問句的信 → 自動建 await_reply 跟進（ref_at=寄出時間 → 之後的 inbound 才算回覆；
    // 對方回覆後 sweep 在 due_at 靜默消除，沒回覆才提醒）。best-effort：失敗絕不影響寄送。
    if (sentMessageId && shouldTrackReply(payload)) {
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, ref_at, status, created_at)
           SELECT ?, user_id, id, thread_id, subject, ?, 1, received_at, 'pending', ?
           FROM messages WHERE id = ? AND user_id = ?`,
        )
          .bind(newId('fu'), now + 3 * 86_400_000, now, sentMessageId, user.id)
          .run();
      } catch (err) {
        console.error('track-reply followup failed', err);
      }
    }
  }

  // 寄件人其他分頁即時看到寄件備份 / 狀態更新（不推播）
  await notifyUser(env, user.id, { type: 'refresh' });
}

async function markFailed(env: Env, sendQueueId: string, error: string): Promise<void> {
  await env.DB.prepare(`UPDATE send_queue SET status = 'failed', last_error = ? WHERE id = ?`)
    .bind(error.slice(0, 500), sendQueueId)
    .run();
}

/**
 * provider 接受後標記 external_state='accepted'（+ external_sent_at 時間戳）。
 * 帶小重試：這是關閉重複窗口的關鍵持久化，盡量讓它成功；最終仍失敗也不拋錯——
 * 此時 external_state 維持 'attempting'，後續任何失敗都會讓重寄轉「待裁決」而非重送。
 */
async function persistAccepted(env: Env, sendQueueId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.DB.prepare(`UPDATE send_queue SET external_state = 'accepted', external_sent_at = ? WHERE id = ?`)
        .bind(Date.now(), sendQueueId)
        .run();
      return;
    } catch (err) {
      if (attempt === 2) {
        await logError(env, 'send.persist', err, { sendQueueId }); // F12.2：重試後仍失敗 → 會漏發送確認
        return;
      }
    }
  }
}
