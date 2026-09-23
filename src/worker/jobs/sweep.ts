// 每分鐘 cron：排程寄送掃描 + 跟進提醒 + 行事曆提醒 + 過期資料清理
import { inboxUnreadCount, notifyUser } from '../lib/notify';
import { purgeMessages } from '../lib/purge';
import { logError } from '../lib/logError';
import { nextOccurrenceFrom, parseRrule } from '../email/rrule';
import { FORWARD_MARKER_TTL_MS } from '../email/forward';
import type { SendJob } from './types';

export async function sweep(env: Env): Promise<void> {
  const now = Date.now();

  // 跟進提醒到期：await_reply 者若該對話串已有新回覆則自動消除，否則觸發推播
  const dueFollowups = await env.DB.prepare(
    `SELECT id, user_id, thread_id, message_id, subject, await_reply, ref_at FROM follow_ups
     WHERE status = 'pending' AND due_at <= ? LIMIT 100`,
  )
    .bind(now)
    .all<{ id: string; user_id: string; thread_id: string; message_id: string; subject: string; await_reply: number; ref_at: number }>();
  for (const f of dueFollowups.results) {
    if (f.await_reply) {
      const replied = await env.DB.prepare(
        `SELECT 1 FROM messages WHERE user_id = ? AND thread_id = ? AND direction = 'inbound' AND received_at > ? LIMIT 1`,
      )
        .bind(f.user_id, f.thread_id, f.ref_at)
        .first();
      if (replied) {
        // 已收到回覆 → 靜默消除（CAS 防重疊 cron 重複處理）
        await env.DB.prepare(`UPDATE follow_ups SET status = 'done' WHERE id = ? AND status = 'pending'`).bind(f.id).run();
        continue;
      }
    }
    // 原子認領：只有把 pending 翻成 fired 的那一次才推播（cron 不保證互斥，防重疊執行重複提醒）
    const claim = await env.DB.prepare(`UPDATE follow_ups SET status = 'fired' WHERE id = ? AND status = 'pending'`)
      .bind(f.id)
      .run();
    if (claim.meta.changes !== 1) continue;
    await notifyUser(env, f.user_id, {
      type: 'new-mail',
      push: {
        title: f.await_reply ? '尚未收到回覆，該跟進了' : '跟進提醒',
        body: f.subject || '(無主旨)',
        url: `/#msg-${f.message_id}`,
      },
    });
  }

  // 行事曆事件提醒到期：推播後把「下次提醒指標」前進到下一次發生（重複事件）或清空（單次）。
  // CAS（WHERE reminder_next_ms = 舊值）認領，防重疊 cron 重複推播。
  const dueReminders = await env.DB.prepare(
    `SELECT id, user_id, summary, start_ms, rrule, reminder_min, reminder_next_ms FROM calendar_events
     WHERE reminder_next_ms IS NOT NULL AND reminder_next_ms <= ? LIMIT 100`,
  )
    .bind(now)
    .all<{ id: string; user_id: string; summary: string; start_ms: number; rrule: string | null; reminder_min: number | null; reminder_next_ms: number }>();
  for (const r of dueReminders.results) {
    const offset = (r.reminder_min ?? 0) * 60_000;
    const firedOccStart = r.reminder_next_ms + offset;
    const rule = parseRrule(r.rrule);
    // 下一次發生：嚴格晚於剛觸發的這次，且其「提醒時刻」(occ - offset) 必須仍在未來，否則
    // 大前置時間（reminderMin 可達 30 天）會讓指標卡在過去 → 每分鐘 cron 補一發、洗版推播。
    // 因到期條件保證 now + offset >= firedOccStart，下界取 now + offset 即一步跳到下個未來提醒、只觸發一次。
    const nextStart = rule ? nextOccurrenceFrom(r.start_ms, rule, Math.max(firedOccStart, now + offset)) : null;
    const newNext = nextStart != null ? nextStart - offset : null;
    const claim = await env.DB.prepare(`UPDATE calendar_events SET reminder_next_ms = ? WHERE id = ? AND reminder_next_ms = ?`)
      .bind(newNext, r.id, r.reminder_next_ms)
      .run();
    if (claim.meta.changes !== 1) continue;
    await notifyUser(env, r.user_id, {
      type: 'new-mail',
      push: { title: '行事曆提醒', body: r.summary || '(無標題)', url: '/#calendar' },
    });
  }

  // 到期的排程寄送 → enqueue（consumer 的原子 claim 讓重複 enqueue 安全）
  const due = await env.DB.prepare(
    `SELECT id FROM send_queue WHERE status = 'scheduled' AND scheduled_at <= ? LIMIT 50`,
  )
    .bind(now)
    .all<{ id: string }>();
  for (const row of due.results) {
    await env.SEND_QUEUE.send({ kind: 'send', sendQueueId: row.id } satisfies SendJob);
  }

  // 卡在 sending 超過 15 分鐘：標 failed 讓使用者看得到（防雙寄守門不自動重送）。
  // 外送已嘗試但結果未定（external_state='attempting'）→ 標為「待裁決」，
  // 由使用者決定重寄或標已送，重寄路徑絕不自動重送外部。
  const cutoff = now - 15 * 60_000;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE send_queue SET status = 'failed', last_error = 'external_uncertain'
       WHERE status = 'sending' AND scheduled_at < ? AND external_state = 'attempting'`,
    ).bind(cutoff),
    env.DB.prepare(
      `UPDATE send_queue SET status = 'failed', last_error = 'stuck in sending (duplicate-send guard)'
       WHERE status = 'sending' AND scheduled_at < ? AND (external_state IS NULL OR external_state = 'accepted')`,
    ).bind(cutoff),
  ]);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM challenges WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL`).bind(now - 24 * 3600 * 1000),
    // F7.7：清過期加密連結（過期後本就服務 410，這裡釋放儲存）
    env.DB.prepare(`DELETE FROM encrypted_links WHERE expires_at < ?`).bind(now),
    // F12.2：error_log 環形保留最近 500 筆（診斷夠用、不無限膨脹）
    env.DB.prepare(`DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY created_at DESC LIMIT 500)`),
    // F11：清過期的轉寄迴圈 marker（超過 TTL 本就不再採信，這裡釋放儲存）
    env.DB.prepare(`DELETE FROM forward_markers WHERE created_at < ?`).bind(now - FORWARD_MARKER_TTL_MS),
  ]);

  // F13.2：Snooze 到期喚醒——逐筆 CAS 認領（每分鐘 cron 可能重疊，changes===1 才推播，絕不重複吵人）。
  // LIMIT 50/輪：家用量級一輪掃完；極端積壓下一分鐘接手。UPDATE 不動 folder → 0037 trigger 不會灌 changes。
  const dueSnooze = await env.DB.prepare(
    `SELECT id, user_id, subject, from_name, from_addr FROM messages
     WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? LIMIT 50`,
  )
    .bind(now)
    .all<{ id: string; user_id: string; subject: string | null; from_name: string | null; from_addr: string }>();
  for (const m of dueSnooze.results) {
    const claim = await env.DB.prepare(
      `UPDATE messages SET snoozed_until = NULL, is_read = 0
       WHERE id = ? AND snoozed_until IS NOT NULL AND snoozed_until <= ?`,
    )
      .bind(m.id, now)
      .run();
    if (claim.meta.changes !== 1) continue; // 另一輪 sweep 已認領
    await notifyUser(env, m.user_id, {
      type: 'snooze-wake',
      push: {
        title: '⏰ 稍後處理的信回來了',
        body: `${m.from_name || m.from_addr}：${m.subject || '(無主旨)'}`,
        url: `/#msg-${m.id}`,
        id: m.id,
        unread: await inboxUnreadCount(env, m.user_id),
      },
    });
  }

  // 孤兒 staged 附件清理：message_id NULL（未綁任何訊息）、>24h（避開與進行中寄送的競態），
  // 且未被任何草稿、或「進行中(scheduled/sending)/待裁決(review)」寄送引用 → 安全刪除（R2 先、列後）。
  // 來源：RSVP 的 REPLY .ics 在外送永久失敗/久未裁決時無人綁定（伺服器產生、無對應草稿可刪），
  // 以及使用者上傳後未存草稿即離開的零散上傳。草稿附件、排程/sending/review 中的附件一律不碰（NOT EXISTS 為保守方向）。
  const attCutoff = now - 24 * 3600 * 1000;
  const orphans = await env.DB.prepare(
    `SELECT a.id, a.r2_key FROM attachments a
     WHERE a.message_id IS NULL AND a.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.user_id = a.user_id AND d.payload LIKE '%"' || a.id || '"%')
       AND NOT EXISTS (
         SELECT 1 FROM send_queue s WHERE s.user_id = a.user_id AND s.payload LIKE '%"' || a.id || '"%'
           AND (s.status IN ('scheduled', 'sending')
                OR (s.status = 'failed' AND s.external_state = 'attempting' AND s.last_error = 'external_uncertain'))
       )
     LIMIT 200`,
  )
    .bind(attCutoff)
    .all<{ id: string; r2_key: string }>();
  for (const o of orphans.results) {
    await env.MAIL_STORE.delete(o.r2_key);
    await env.DB.prepare(`DELETE FROM attachments WHERE id = ?`).bind(o.id).run();
  }

  // F4.6b：分享連結到期前提醒（48h 內到期、未過期、尚未提醒）→ 原子認領後推播一次（防 cron 重疊重複）。
  try {
    const soon = await env.DB.prepare(
      `SELECT id, user_id, filename FROM shared_files WHERE expires_at > ? AND expires_at <= ? AND expiry_reminded = 0 LIMIT 200`,
    )
      .bind(now, now + 48 * 3600 * 1000)
      .all<{ id: string; user_id: string; filename: string }>();
    for (const s of soon.results) {
      try {
        const claim = await env.DB.prepare(`UPDATE shared_files SET expiry_reminded = 1 WHERE id = ? AND expiry_reminded = 0`).bind(s.id).run();
        if (claim.meta.changes !== 1) continue;
        await notifyUser(env, s.user_id, {
          type: 'new-mail',
          push: { title: '分享連結即將到期', body: `「${s.filename}」的分享連結將在 48 小時內到期，可到設定→儲存延長。`, url: '/#settings' },
        });
      } catch (e) {
        console.error('share reminder item failed', s.id, e); // 單筆失敗不中斷其餘提醒
      }
    }
  } catch (err) {
    console.error('share expiry reminder failed', err); // best-effort：不影響 sweep 其他職責
  }

  // 大附件分享：過期者刪 R2 物件 + DB 列（下載連結 7 天到期）
  const expiredShares = await env.DB.prepare(`SELECT id, r2_key FROM shared_files WHERE expires_at < ? LIMIT 200`)
    .bind(now)
    .all<{ id: string; r2_key: string }>();
  for (const s of expiredShares.results) {
    await env.MAIL_STORE.delete(s.r2_key);
    await env.DB.prepare(`DELETE FROM shared_files WHERE id = ?`).bind(s.id).run();
  }

  // 垃圾分類器：回收因類別來回切換而歸零的 token 列（無功能影響，純瘦身）
  await env.DB.prepare(`DELETE FROM spam_tokens WHERE spam_count = 0 AND ham_count = 0`).run();

  // F9.1：spam/trash 超過 30 天自動永久清（預設開；設定 prefs.purgeSpamTrash=false 可按人關閉）。
  // 安全邊界：只清 folder_changed_at 已知且過期者——NULL 永不清（migration 已 backfill，此為防禦）；
  // 起算點 = 進入該資料夾的時間（trigger 維護），舊信丟進垃圾桶從丟入日重算 30 天，絕不追溯誤刪。
  try {
    const purgeCutoff = now - 30 * 86400_000;
    const stale = await env.DB.prepare(
      `SELECT m.id, m.user_id FROM messages m
       LEFT JOIN user_settings us ON us.user_id = m.user_id
       WHERE m.folder IN ('spam', 'trash')
         AND m.folder_changed_at IS NOT NULL AND m.folder_changed_at < ?
         AND COALESCE(json_extract(us.prefs, '$.purgeSpamTrash'), 1) NOT IN (0, 'false')
       LIMIT 50`,
    )
      .bind(purgeCutoff)
      .all<{ id: string; user_id: string }>();
    if (stale.results.length) await purgeMessages(env, stale.results, purgeCutoff);
  } catch (err) {
    await logError(env, 'sweep.purgeSpamTrash', err); // F12.2：整段失敗 → 垃圾持續累積
  }

  // F9.2：每資料夾/lane 保留規則（opt-in，預設永久）。只做判定精準的兩類：
  // archive（folder 精準）與 newsletter（list_unsubscribe 強訊號）；receipt 是主旨啟發式，
  // 不拿來當不可逆刪除依據（誤判即誤刪）。
  // 豁免（對抗式審查加固）：星標/釘選/稍後處理中/工作流狀態/待跟進/匯入史（import_job_id）永不清；
  // 電子報另外只清「已讀且使用者沒回覆過的串」——群組討論/GitHub 通知也帶 List-Unsubscribe，
  // 未讀或參與過的對話不可逆刪除太危險。SELECT 與 purge 認領雙層驗證。
  const userSignalExempt = `AND is_starred = 0 AND pinned_at IS NULL AND snoozed_until IS NULL
        AND message_status IS NULL AND import_job_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.message_id = messages.id AND f.status = 'pending')`;
  try {
    const retentionUsers = await env.DB.prepare(
      `SELECT user_id,
              json_extract(prefs, '$.retention.archive') AS arch,
              json_extract(prefs, '$.retention.newsletter') AS news
       FROM user_settings
       WHERE json_extract(prefs, '$.retention.archive') >= 30
          OR json_extract(prefs, '$.retention.newsletter') >= 30`,
    ).all<{ user_id: string; arch: number | null; news: number | null }>();
    for (const u of retentionUsers.results) {
      // >=30 天下限硬 guard：API 只收 0/30/90/365，此處再擋一次（防髒資料把保留期弄到危險地短）
      if (typeof u.arch === 'number' && u.arch >= 30) {
        const cut = now - u.arch * 86400_000;
        const rows = await env.DB.prepare(
          `SELECT id, user_id FROM messages
           WHERE user_id = ? AND folder = 'archive'
             AND folder_changed_at IS NOT NULL AND folder_changed_at < ?
             ${userSignalExempt}
           LIMIT 30`,
        ).bind(u.user_id, cut).all<{ id: string; user_id: string }>();
        if (rows.results.length) await purgeMessages(env, rows.results, cut, { folders: ['archive'], exemptUserSignals: true });
      }
      if (typeof u.news === 'number' && u.news >= 30) {
        const cut = now - u.news * 86400_000;
        const rows = await env.DB.prepare(
          `SELECT id, user_id FROM messages
           WHERE user_id = ? AND list_unsubscribe IS NOT NULL AND screening = 0
             AND folder IN ('inbox', 'archive')
             AND folder_changed_at IS NOT NULL AND folder_changed_at < ?
             AND is_read = 1
             AND NOT EXISTS (SELECT 1 FROM messages o
                             WHERE o.user_id = messages.user_id AND o.thread_id = messages.thread_id
                               AND o.direction = 'outbound')
             ${userSignalExempt}
           LIMIT 30`,
        ).bind(u.user_id, cut).all<{ id: string; user_id: string }>();
        if (rows.results.length) await purgeMessages(env, rows.results, cut, { folders: ['inbox', 'archive'], exemptUserSignals: true, requireRead: true });
      }
    }
  } catch (err) {
    await logError(env, 'sweep.retention', err); // F12.2：整段失敗 → 保留規則未生效
  }
}
