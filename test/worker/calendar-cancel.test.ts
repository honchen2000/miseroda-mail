// F16.2 / 2026-09-20 安全掃描 F8：收到的 METHOD:CANCEL 不得只憑 UID 就刪掉會議。
// 情境逐條對應 docs/product-roadmap.md F16.2 的「驗證」欄。
// 關鍵設計（兩輪擋點的產物）：**任何取消都不直接刪除**——
//   通過授權 → 標 cancel_pending，等使用者確認；未通過 → 事件完全不動，只留 F16.1 的 blocked 警示。
// 並補上本樹唯一的刪除路徑（使用者確認移除），否則「拒絕取消」會讓事件永遠移不掉。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { cancelCalendarEvent, deleteCalendarEvent, dismissCalendarFlags, upsertCalendarEvent } from '../../src/worker/email/calendarStore';
import type { CalendarEvent } from '../../src/worker/email/calendar';
import { seedUser } from './helpers/fixtures';

const uniq = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

function ev(uid: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    method: 'REQUEST', summary: '週會', startText: '2026/10/01 09:00', endText: null,
    startMs: Date.UTC(2026, 9, 1, 9, 0), endMs: null, allDay: false, location: '',
    description: null, organizer: { name: null, email: 'boss@example.com' },
    uid, rrule: null, sequence: 0, ...over,
  };
}

type Row = { id: string; summary: string; cancel_pending: number; cancel_by: string; blocked_by: string; reminder_next_ms: number | null };
const read = (uid: string) =>
  env.DB.prepare(`SELECT id, summary, cancel_pending, cancel_by, blocked_by, reminder_next_ms FROM calendar_events WHERE uid = ?`)
    .bind(uid)
    .first<Row>();

describe('收到的 CANCEL（F16.2）', () => {
  it('陌生人 CANCEL：事件完全不動、不標待確認，只留下被擋的警示', async () => {
    const u = await seedUser(env, `cc1-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    await upsertCalendarEvent(env, u.userId, ev(uid), { source: 'received', authAddr: 'boss@example.com' });

    expect(await cancelCalendarEvent(env, u.userId, uid, 'mallory@evil.example')).toBe('blocked');
    const r = (await read(uid))!;
    expect(r.summary).toBe('週會');       // 事件還在
    expect(r.cancel_pending).toBe(0);     // 不會被標成待確認 → 不會誘使使用者去刪
    expect(r.blocked_by).toBe('mallory@evil.example');
  });

  it('原 organizer CANCEL：標記待確認，但**不刪除**，提醒時間也不動', async () => {
    const u = await seedUser(env, `cc2-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    await upsertCalendarEvent(env, u.userId, ev(uid), { source: 'received', authAddr: 'boss@example.com', reminderMin: 10, reminderNextMs: 123456 });

    expect(await cancelCalendarEvent(env, u.userId, uid, 'BOSS@example.com')).toBe('pending');
    const r = (await read(uid))!;
    expect(r.cancel_pending).toBe(1);
    expect(r.cancel_by).toBe('boss@example.com');
    expect(r.summary).toBe('週會');           // 仍在，等使用者確認
    expect(r.reminder_next_ms).toBe(123456);  // 確認之前提醒照發（刻意的取捨，見 calendarStore 註解）
  });

  it('使用者確認移除 → 真的刪掉；選擇保留 → 旗標清掉但事件留著', async () => {
    const u = await seedUser(env, `cc3-${uniq()}@miseroda.com`);
    const keepUid = `uid-${uniq()}@x`;
    const dropUid = `uid-${uniq()}@x`;
    for (const uid of [keepUid, dropUid]) {
      await upsertCalendarEvent(env, u.userId, ev(uid), { source: 'received', authAddr: 'boss@example.com' });
      await cancelCalendarEvent(env, u.userId, uid, 'boss@example.com');
    }

    expect(await dismissCalendarFlags(env, u.userId, (await read(keepUid))!.id)).toBe(true);
    const kept = (await read(keepUid))!;
    expect(kept.cancel_pending).toBe(0);
    expect(kept.cancel_by).toBe('');
    expect(kept.summary).toBe('週會');

    expect(await deleteCalendarEvent(env, u.userId, (await read(dropUid))!.id)).toBe(true);
    expect(await read(dropUid)).toBeNull();
  });

  it('自建事件不受外來 CANCEL 影響', async () => {
    const u = await seedUser(env, `cc4-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    await upsertCalendarEvent(env, u.userId, ev(uid, { summary: '我自己排的' }), { source: 'created', authAddr: 'boss@example.com' });

    // 連「位址對得上」都不行：自建事件只能由使用者自己移除
    expect(await cancelCalendarEvent(env, u.userId, uid, 'boss@example.com')).toBe('blocked');
    const r = (await read(uid))!;
    expect(r.cancel_pending).toBe(0);
    expect(r.summary).toBe('我自己排的');
  });

  it('移除端點只動得了自己的事件：別人的列刪不掉（404）', async () => {
    const victim = await seedUser(env, `cc5v-${uniq()}@miseroda.com`);
    const attacker = await seedUser(env, `cc5a-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    await upsertCalendarEvent(env, victim.userId, ev(uid), { source: 'received', authAddr: 'boss@example.com' });
    const rowId = (await read(uid))!.id;

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://mail.miseroda.com/api/v1/calendar/events/${rowId}/remove`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-session=${encodeURIComponent(attacker.cookies.session)}; __Host-csrf=${encodeURIComponent(attacker.cookies.csrf)}`,
          'X-CSRF-Token': attacker.cookies.csrf,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await read(uid)).not.toBeNull(); // 受害者的事件還在
  });
});
