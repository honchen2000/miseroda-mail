// 行事曆事件表的寫入：由 ingest（收到的邀請）、自建會議邀請、RSVP 共同填充。
import { newId } from '../lib/ids';
import type { CalendarEvent } from './calendar';

/** 由顯示字串 "YYYY/MM/DD[ HH:MM]" 取分桶用 epoch（以 UTC 視之）。 */
function fromText(text: string | null): number | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})(?:\s+(\d{2}):(\d{2}))?/.exec(text ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0);
}

/** 分桶用起始 epoch：UTC/日期事件用真實 startMs；TZID/浮動用牆鐘字串近似（floating=true）。 */
export function gridStart(ev: CalendarEvent): { startMs: number; floating: boolean } | null {
  if (ev.startMs != null) return { startMs: ev.startMs, floating: false };
  const ms = fromText(ev.startText);
  return ms == null ? null : { startMs: ms, floating: true };
}

export interface UpsertOpts {
  source: 'received' | 'created';
  rsvpStatus?: string | null;
  messageId?: string | null;
  /** 提醒提前分鐘數（0 = 開始時；null/undefined = 不提醒）。僅自建事件由使用者指定。 */
  reminderMin?: number | null;
  /** 下次提醒應觸發的 epoch ms（由 computeReminderNextMs 算好傳入）。 */
  reminderNextMs?: number | null;
  /**
   * F16.1：本次寫入的「授權位址」。
   * - 收到的邀請（source='received'）：該封信的 From 位址。插入時寫死成這一列的 auth_addr，
   *   日後只有它、或既存 organizer，才改得動這一列。
   * - 自建（source='created'）／站內邀請：擁有者或邀請人的位址。
   * 缺這個值時，收到的 .ics 一律無法更新既有列（fail closed）。
   */
  authAddr?: string | null;
}

/** 寫入結果。blocked＝授權不符或 SEQUENCE 倒退，已留下使用者看得見的訊號但未改動內容。 */
export type UpsertOutcome = 'inserted' | 'updated' | 'blocked' | 'skipped';

const normAddr = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

interface ExistingRow {
  id: string;
  source: string;
  organizer: string;
  auth_addr: string;
  seq: number;
  start_ms: number;
}

/** 記下被拒絕的更新，讓使用者看得見（F16.1 驗收：只寫 admin-only audit 不算）。 */
async function markBlocked(env: Env, rowId: string, by: string): Promise<void> {
  await env.DB.prepare(`UPDATE calendar_events SET blocked_at = ?, blocked_by = ? WHERE id = ?`)
    .bind(Date.now(), by.slice(0, 320), rowId)
    .run();
}

/**
 * 新增 / 更新一筆行事曆事件（以 (user_id, uid) 去重）。CANCEL 由呼叫端改走 removeCalendarEvent。
 *
 * F16.1（2026-09-20 安全掃描 F1/F4/F5）：原本是無條件的 ON CONFLICT DO UPDATE，
 * 於是任何知道 UID 的人（每位共同受邀者都知道）寄一封信就能改掉別人的行事曆。
 * 現在改成「先查既有列 → 判授權 → 再寫」。**刻意不用 ON CONFLICT ... WHERE**：
 * 那種寫法無法分辨「授權不符」與「本來就沒有衝突」，也就寫不出被拒訊號。
 *
 * 授權規則（收到的 .ics）：
 *   1. 絕不得碰 source='created' 的列——那是使用者自己建立的事件。
 *   2. 寄件者必須等於這一列的 auth_addr（插入時寫死）**或**既存 organizer。
 *      兩者擇一是刻意的：只認 organizer 會誤殺合法的中繼／代寄改期（訂票系統 noreply、SENT-BY 代理），
 *      那正是前一輪修補被擋下的原因。
 *   3. SEQUENCE 不得倒退（擋重放舊 .ics）。
 */
export async function upsertCalendarEvent(env: Env, userId: string, ev: CalendarEvent, opts: UpsertOpts): Promise<UpsertOutcome> {
  if (!ev.uid) return 'skipped'; // 無 UID 無法去重 → 不入行事曆（信件邀請卡仍可見）
  const grid = gridStart(ev);
  if (!grid) return 'skipped'; // 無法定位日期 → 跳過
  const endMs = ev.endMs ?? fromText(ev.endText);
  const organizer = ev.organizer?.email ?? '';
  const authAddr = normAddr(opts.authAddr);

  const existing = await env.DB.prepare(
    `SELECT id, source, organizer, auth_addr, seq, start_ms FROM calendar_events WHERE user_id = ? AND uid = ?`,
  )
    .bind(userId, ev.uid)
    .first<ExistingRow>();

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO calendar_events
         (id, user_id, uid, summary, start_ms, end_ms, start_text, all_day, floating, location, organizer, source,
          rsvp_status, message_id, rrule, reminder_min, reminder_next_ms, auth_addr, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, uid) DO NOTHING`,
    )
      .bind(
        newId('cev'), userId, ev.uid, ev.summary ?? '', grid.startMs, endMs ?? null, ev.startText ?? '',
        ev.allDay ? 1 : 0, grid.floating ? 1 : 0, ev.location ?? '', organizer, opts.source,
        opts.rsvpStatus ?? null, opts.messageId ?? null, ev.rrule ?? null,
        opts.reminderMin ?? null, opts.reminderNextMs ?? null,
        // 授權位址插入時寫死、之後永不更新（比照 source）。收到的邀請若沒帶 From，退回 organizer，
        // 免得這一列變成「auth_addr 與 organizer 皆空」而誰都改不動。
        authAddr || normAddr(organizer), ev.sequence ?? 0, Date.now(),
      )
      .run();
    // DO NOTHING：極窄的併發窗（同一封信重跑／同時兩封同 UID）不該變成 500，交給下次更新收斂。
    return 'inserted';
  }

  if (opts.source === 'received') {
    if (existing.source === 'created') {
      await markBlocked(env, existing.id, authAddr || organizer);
      return 'blocked'; // 收到的 .ics 永遠不得改動使用者自建的事件
    }
    const allowed = !!authAddr && (authAddr === normAddr(existing.auth_addr) || authAddr === normAddr(existing.organizer));
    if (!allowed) {
      await markBlocked(env, existing.id, authAddr || organizer);
      return 'blocked';
    }
    if ((ev.sequence ?? 0) < existing.seq) {
      await markBlocked(env, existing.id, authAddr);
      return 'blocked'; // SEQUENCE 倒退 ＝ 重放舊版本
    }
  }

  await env.DB.prepare(
    `UPDATE calendar_events SET
       summary = ?, start_ms = ?, end_ms = ?, start_text = ?, all_day = ?, floating = ?, location = ?, organizer = ?, rrule = ?,
       message_id = COALESCE(?, message_id),
       -- 提醒：僅在呼叫端確有帶提醒時覆蓋；ingest 收信不帶 → 保留既有，
       -- 避免外部與會者 REPLY 回帶同 UID 的 .ics 把自建事件已設好的提醒抹掉。
       reminder_min = CASE WHEN ? IS NOT NULL THEN ? ELSE reminder_min END,
       reminder_next_ms = CASE WHEN ? IS NOT NULL THEN ? ELSE reminder_next_ms END,
       -- 改期（start_ms 變動）→ 清掉出席狀態，讓使用者重新確認；否則保留
       rsvp_status = CASE WHEN ? <> start_ms THEN NULL ELSE rsvp_status END,
       seq = MAX(seq, ?),
       -- 合法更新進來 → 清掉先前被拒的警示，避免陳舊訊號一直掛著
       blocked_at = NULL, blocked_by = ''
     WHERE id = ?`,
  )
    .bind(
      ev.summary ?? '', grid.startMs, endMs ?? null, ev.startText ?? '',
      ev.allDay ? 1 : 0, grid.floating ? 1 : 0, ev.location ?? '', organizer, ev.rrule ?? null,
      opts.messageId ?? null,
      // reminderMin 綁三次：兩個 CASE 的判斷式各一次、reminder_min 的值一次（SQLite 匿名參數依序取值）
      opts.reminderMin ?? null, opts.reminderMin ?? null, opts.reminderMin ?? null, opts.reminderNextMs ?? null,
      // SQLite 的 UPDATE 右側一律讀「更新前」的列值 → 這裡比的是新 startMs vs 舊 start_ms，語意與原本一致
      grid.startMs, ev.sequence ?? 0, existing.id,
    )
    .run();
  return 'updated';
}

/** 收到的 CANCEL 的處理結果。 */
export type CancelOutcome = 'pending' | 'blocked' | 'skipped';

/**
 * 收到的 METHOD:CANCEL（F16.2／2026-09-20 安全掃描 F8）。
 *
 * **絕不直接刪除。** 原本的 DELETE 只比對 (user_id, uid, source='received')，
 * 於是任何知道 UID 的人（同一封邀請的其他受邀者都知道）寄一封信就能刪掉受害者的會議。
 * 而「加個 organizer 檢查就好」是前一輪被擋下的做法，理由有二（docs/product-roadmap.md F16.2）：
 *   ① organizer 可被 upsert 覆寫 → 先改 organizer 再 CANCEL 照樣得逞。此點已由 F16.1 的
 *      auth_addr（插入時寫死）關掉，這裡的授權因此改用同一把尺。
 *   ② 就算授權綁對了，全樹只有這一條刪除路徑 → 任何被拒的取消都會讓事件**永遠移不掉**、提醒繼續跑。
 * 所以通過授權的取消也只是標記 cancel_pending，由使用者在行事曆上確認後才真的移除
 *（deleteCalendarEvent）；未通過授權的則完全不動事件，只留下 F16.1 的 blocked 警示。
 *
 * 提醒在確認之前照常發送——反過來做（標記時就停發）等於讓陌生人寄一封 CANCEL 就能靜音你的提醒，
 * 那是把漏洞保留了一半。代價是真的被取消的會議會多提醒一次，直到使用者按下確認。
 */
export async function cancelCalendarEvent(env: Env, userId: string, uid: string, byAddr: string | null | undefined): Promise<CancelOutcome> {
  const who = normAddr(byAddr);
  const existing = await env.DB.prepare(
    `SELECT id, source, organizer, auth_addr FROM calendar_events WHERE user_id = ? AND uid = ?`,
  )
    .bind(userId, uid)
    .first<{ id: string; source: string; organizer: string; auth_addr: string }>();
  if (!existing) return 'skipped';

  // 自建事件永遠不受外來 CANCEL 影響；授權比照 F16.1（auth_addr 或既存 organizer 擇一）。
  const allowed =
    existing.source === 'received' &&
    !!who &&
    (who === normAddr(existing.auth_addr) || who === normAddr(existing.organizer));
  if (!allowed) {
    await markBlocked(env, existing.id, who || '(unknown)');
    return 'blocked';
  }
  await env.DB.prepare(`UPDATE calendar_events SET cancel_pending = 1, cancel_by = ? WHERE id = ?`)
    .bind(who.slice(0, 320), existing.id)
    .run();
  return 'pending';
}

/** 使用者確認後的真正移除（本樹唯一的刪除路徑；不限 source，使用者本來就該能刪自己的事件）。 */
export async function deleteCalendarEvent(env: Env, userId: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM calendar_events WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** 使用者選擇保留：清掉待確認取消與被拒警示，事件照常留著。 */
export async function dismissCalendarFlags(env: Env, userId: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE calendar_events SET cancel_pending = 0, cancel_by = '', blocked_at = NULL, blocked_by = '' WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function setEventRsvp(env: Env, userId: string, uid: string, status: string): Promise<void> {
  await env.DB.prepare(`UPDATE calendar_events SET rsvp_status = ? WHERE user_id = ? AND uid = ?`).bind(status, userId, uid).run();
}
