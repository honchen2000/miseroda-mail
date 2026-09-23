// 行事曆重複事件 + 提醒整合：個人重複事件 → /calendar/events 展開 → cron 提醒觸發並前進指標；
// 自建邀請的 .ics 帶 RRULE；來信 RRULE 解析後展開。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { sweep } from '../../src/worker/jobs/sweep';
import { buildRequest, parseIcs } from '../../src/worker/email/calendar';
import { upsertCalendarEvent } from '../../src/worker/email/calendarStore';

const BASE = 'https://mail.miseroda.com/api/v1';
function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} }, SEND_QUEUE: { send: async () => {} } } as unknown as typeof env;
}
function post(path: string, cookies: { session: string; csrf: string }, body: unknown) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    quietEnv(),
    createExecutionContext(),
  );
}
function get(path: string, cookies: { session: string; csrf: string }) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
      },
    }),
    quietEnv(),
    createExecutionContext(),
  );
}

const DAY = 86400_000;

describe('calendar recurrence + reminder', () => {
  it('個人每週事件（0 與會者）→ 展開 + 提醒指標前進', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const now = Date.now();
    const startMs = now + 5 * 60_000; // 5 分鐘後（提醒 15 分前 → 指標已到期）
    const endMs = startMs + 3600_000;

    const res = await post('/calendar/invite', hon.cookies, {
      summary: '每週倒垃圾',
      attendees: [], // 個人事件：不寄信
      startMs,
      endMs,
      recurrence: 'weekly',
      reminderMin: 15,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, attendees: 0, personal: true });

    const row = await env.DB.prepare(
      `SELECT source, rrule, reminder_min, reminder_next_ms FROM calendar_events WHERE user_id = ?`,
    )
      .bind(hon.userId)
      .first<{ source: string; rrule: string; reminder_min: number; reminder_next_ms: number }>();
    expect(row?.source).toBe('created');
    expect(row?.rrule).toBe('FREQ=WEEKLY');
    expect(row?.reminder_min).toBe(15);
    expect(row?.reminder_next_ms).toBe(startMs - 15 * 60_000); // start - 15min

    // 月檢視範圍展開：5 週內每週一場（startMs, +7, +14, +21, +28）
    const evJson = await (await get(`/messages?folder=inbox`, hon.cookies)).json(); // 確保 session ok（非斷言）
    void evJson;
    const ev = await (await get(`/calendar/events?from=${now}&to=${now + 35 * DAY}`, hon.cookies)).json<{
      events: { startMs: number; summary: string; recurring: boolean }[];
    }>();
    expect(ev.events.length).toBe(5);
    expect(ev.events.every((e) => e.recurring && e.summary === '每週倒垃圾')).toBe(true);
    expect(ev.events[0].startMs).toBe(startMs);
    expect(ev.events[1].startMs).toBe(startMs + 7 * DAY);

    // cron：到期提醒觸發 → 指標前進到下週的提醒（startMs+7d - 15min）
    await sweep(quietEnv());
    const after = await env.DB.prepare(`SELECT reminder_next_ms FROM calendar_events WHERE user_id = ?`)
      .bind(hon.userId)
      .first<{ reminder_next_ms: number }>();
    expect(after?.reminder_next_ms).toBe(startMs + 7 * DAY - 15 * 60_000);
  });

  it('大前置提醒的重複事件：cron 一步跳到未來提醒，不每 tick 補發（Codex R5 #1）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const now = Date.now();
    const startMs = now + 2 * DAY; // 首場 2 天後
    const offsetMin = 43200; // 30 天前置（reminderMin 上限）
    const offset = offsetMin * 60_000; // = 30 天
    // 直接種：提醒指標落在過去（startMs - 30d = now - 28d）→ 舊碼會每 tick 補一發
    await upsertCalendarEvent(
      env,
      hon.userId,
      {
        method: 'REQUEST', summary: '每天運動', startText: '', endText: null,
        startMs, endMs: startMs + 3600_000, allDay: false, location: null, description: null,
        organizer: { name: null, email: 'hon@miseroda.com' }, uid: 'daily@miseroda.com', rrule: 'FREQ=DAILY',
      },
      { source: 'created', rsvpStatus: 'accepted', reminderMin: offsetMin, reminderNextMs: startMs - offset },
    );

    // sweep #1：應一步跳到「提醒時刻仍在未來」的場次，不再停留在過去
    await sweep(quietEnv());
    const a1 = await env.DB.prepare(`SELECT reminder_next_ms FROM calendar_events WHERE user_id = ? AND uid = ?`)
      .bind(hon.userId, 'daily@miseroda.com')
      .first<{ reminder_next_ms: number }>();
    expect(a1!.reminder_next_ms).toBeGreaterThan(now); // 關鍵：指標不再卡在過去
    expect(a1!.reminder_next_ms).toBe(startMs + 29 * DAY - offset); // 首個提醒時刻 > now 的場次（= now + 1d）

    // sweep #2：已不到期 → 指標不動，證明沒有每分鐘補發
    await sweep(quietEnv());
    const a2 = await env.DB.prepare(`SELECT reminder_next_ms FROM calendar_events WHERE user_id = ? AND uid = ?`)
      .bind(hon.userId, 'daily@miseroda.com')
      .first<{ reminder_next_ms: number }>();
    expect(a2!.reminder_next_ms).toBe(a1!.reminder_next_ms);
  });

  it('收信回帶同 UID 的 .ics 不抹掉自建事件已設的提醒', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const startMs = Date.UTC(2026, 5, 1, 1, 0);
    const ev = {
      method: 'REQUEST', summary: '會議', startText: '', endText: null, startMs, endMs: startMs + 3600_000,
      allDay: false, location: null, description: null, organizer: { name: null, email: 'hon@miseroda.com' },
      uid: 'shared@miseroda.com', rrule: null,
    };
    // 自建（帶提醒）
    await upsertCalendarEvent(env, hon.userId, ev, {
      source: 'created', rsvpStatus: 'accepted', reminderMin: 15, reminderNextMs: startMs - 900_000,
    });
    // 外部回帶同 UID（ingest 路徑，無 reminder opts）
    await upsertCalendarEvent(env, hon.userId, { ...ev }, { source: 'received' });
    const row = await env.DB.prepare(`SELECT reminder_min, reminder_next_ms FROM calendar_events WHERE user_id = ? AND uid = ?`)
      .bind(hon.userId, 'shared@miseroda.com')
      .first<{ reminder_min: number | null; reminder_next_ms: number | null }>();
    expect(row?.reminder_min).toBe(15); // 保留，未被抹成 NULL
    expect(row?.reminder_next_ms).toBe(startMs - 900_000);
  });

  it('ICS 帶 RRULE：buildRequest 輸出 RRULE，parseIcs 還原', () => {
    const ics = buildRequest({
      uid: 'u1@miseroda.com',
      organizerEmail: 'hon@miseroda.com',
      attendees: ['a@example.com'],
      summary: '週會',
      startMs: Date.UTC(2026, 5, 1, 1, 0),
      endMs: Date.UTC(2026, 5, 1, 2, 0),
      dtStampMs: Date.UTC(2026, 5, 1, 0, 0),
      rrule: 'FREQ=WEEKLY',
    });
    expect(ics).toContain('RRULE:FREQ=WEEKLY');
    const ev = parseIcs(ics)!;
    expect(ev.rrule).toBe('FREQ=WEEKLY');
    expect(ev.summary).toBe('週會');
  });
});
