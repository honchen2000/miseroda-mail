// 「今日」聚合：把 行事曆事件 × 跟進提醒 × Snooze 醒來的信 × 排程寄送 四個時間錨點
// 收斂成單一時間軸。供 GET /agenda 與晨報 digest 共用。台灣固定 UTC+8（全年無日光節約）。
import { expandOccurrences, parseRrule } from '../email/rrule';

export interface AgendaItem {
  kind: 'event' | 'followup' | 'snooze' | 'scheduled';
  at: number; // 該事項的時間（事件開始 / 跟進到期 / snooze 醒來 / 排程寄送）
  title: string;
  sub?: string;
  url: string; // 深連結（晨報/推播用）
  messageId?: string; // 有的話 → 前端用 onOpenMessage 開信
  overdue?: boolean; // 跟進：已逾期
}

/** 某時刻所在「台北日」的 [from, to)（UTC epoch ms）。 */
export function taipeiDayWindow(now: number): { from: number; to: number } {
  const off = 8 * 3600_000; // UTC+8
  const from = Math.floor((now + off) / 86_400_000) * 86_400_000 - off;
  return { from, to: from + 86_400_000 };
}

function safeSubject(payload: string): string {
  try {
    const p = JSON.parse(payload) as { subject?: string };
    return (p.subject || '').trim() || '(無主旨)';
  } catch {
    return '(排程寄送)';
  }
}

/**
 * 該使用者在 [from, to) 的今日待辦，依時間排序。
 * 跟進額外含「逾期未完成」者（due_at < from 仍 pending/fired）；其餘三類嚴格落在當日窗口。
 */
export async function buildAgenda(
  env: Env,
  userId: string,
  from: number,
  to: number,
  /** 請求路徑請傳 `c.var.db`（走 D1 session → 開複本後這 5 個讀取才吃得到就近複本）；
   *  背景任務省略即可（預設 env.DB＝主庫，本來就正確）。 */
  db: D1Database | D1DatabaseSession = env.DB,
): Promise<AgendaItem[]> {
  const [single, recurring, followups, snoozes, scheduled] = await Promise.all([
    // 單次事件：start 落今日（rrule IS NULL 才在這裡，避免與展開的重複事件重複計）
    db.prepare(
      `SELECT summary, start_ms FROM calendar_events
         WHERE user_id = ? AND rrule IS NULL AND start_ms >= ? AND start_ms < ? ORDER BY start_ms LIMIT 100`,
    )
      .bind(userId, from, to)
      .all<{ summary: string; start_ms: number }>(),
    // 重複事件：base 早於 to 者，展開今日落點（與行事曆月/週檢視同一套 expandOccurrences）
    db.prepare(
      `SELECT summary, start_ms, rrule FROM calendar_events
         WHERE user_id = ? AND rrule IS NOT NULL AND start_ms < ? LIMIT 200`,
    )
      .bind(userId, to)
      .all<{ summary: string; start_ms: number; rrule: string }>(),
    db.prepare(
      `SELECT message_id, subject, due_at FROM follow_ups
         WHERE user_id = ? AND status IN ('pending','fired') AND due_at < ? ORDER BY due_at LIMIT 100`,
    )
      .bind(userId, to)
      .all<{ message_id: string; subject: string; due_at: number }>(),
    db.prepare(
      `SELECT id, subject, from_name, from_addr, snoozed_until FROM messages
         WHERE user_id = ? AND snoozed_until >= ? AND snoozed_until < ? ORDER BY snoozed_until LIMIT 100`,
    )
      .bind(userId, from, to)
      .all<{ id: string; subject: string; from_name: string; from_addr: string; snoozed_until: number }>(),
    db.prepare(
      `SELECT payload, scheduled_at FROM send_queue
         WHERE user_id = ? AND status = 'scheduled' AND scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at LIMIT 100`,
    )
      .bind(userId, from, to)
      .all<{ payload: string; scheduled_at: number }>(),
  ]);

  const eventItems: AgendaItem[] = single.results.map((e) => ({
    kind: 'event' as const,
    at: e.start_ms,
    title: e.summary || '(無標題)',
    url: '/#calendar',
  }));
  for (const r of recurring.results) {
    const rule = parseRrule(r.rrule);
    if (!rule) continue;
    for (const occ of expandOccurrences(r.start_ms, rule, from, to)) {
      eventItems.push({ kind: 'event', at: occ, title: r.summary || '(無標題)', url: '/#calendar' });
    }
  }

  const items: AgendaItem[] = [
    ...eventItems,
    ...followups.results.map((f) => ({
      kind: 'followup' as const,
      at: f.due_at,
      title: f.subject || '(待跟進)',
      url: `/#msg-${f.message_id}`,
      messageId: f.message_id,
      overdue: f.due_at < from,
    })),
    ...snoozes.results.map((m) => ({
      kind: 'snooze' as const,
      at: m.snoozed_until,
      title: m.subject || '(無主旨)',
      sub: m.from_name || m.from_addr,
      url: `/#msg-${m.id}`,
      messageId: m.id,
    })),
    ...scheduled.results.map((s) => ({ kind: 'scheduled' as const, at: s.scheduled_at, title: safeSubject(s.payload), url: '/#folder/sent' })),
  ];
  return items.sort((a, b) => a.at - b.at);
}
