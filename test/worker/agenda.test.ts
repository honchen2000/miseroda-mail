// F2.1：今日聚合 buildAgenda —— 信(snooze 醒來)×行事曆×跟進×排程寄送 收斂成單一時間軸。
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { seedUser } from './helpers/fixtures';
import { buildAgenda, taipeiDayWindow } from '../../src/worker/lib/agenda';

const FROM = 1_750_000_000_000; // 固定窗口起點
const TO = FROM + 86_400_000;
const H = 3_600_000;

describe('agenda 今日聚合（F2.1）', () => {
  it('taipeiDayWindow：24h 窗口且對齊台北午夜', () => {
    const { from, to } = taipeiDayWindow(Date.UTC(2026, 5, 23, 10, 0));
    expect(to - from).toBe(86_400_000);
    expect((from + 8 * H) % 86_400_000).toBe(0); // from+8h（=UTC 觀點的台北午夜）對齊整日
  });

  it('buildAgenda：聚合四類、依時間排序、跟進含逾期、排除窗外', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    const uid = u.userId;
    // 窗內（依時間：逾期跟進 < 事件 < 今日跟進 < snooze < 排程）
    await env.DB.prepare(`INSERT INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, status, created_at) VALUES ('fu1', ?, 'm-over', 't-o', '逾期跟進', ?, 0, 'pending', 0)`).bind(uid, FROM - 2 * H).run();
    await env.DB.prepare(`INSERT INTO calendar_events (id, user_id, uid, summary, start_ms, created_at) VALUES ('ev1', ?, 'uid1', '晨會', ?, 0)`).bind(uid, FROM + 9 * H).run();
    await env.DB.prepare(`INSERT INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, status, created_at) VALUES ('fu2', ?, 'm-today', 't-t', '今日跟進', ?, 0, 'pending', 0)`).bind(uid, FROM + 11 * H).run();
    await env.DB.prepare(`INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, snoozed_until, received_at, created_at) VALUES ('m-snz', ?, 't1', 'inbound', 'a@x.com', '小明', '稍後處理的信', '', 'inbox', ?, 0, 0)`).bind(uid, FROM + 13 * H).run();
    await env.DB.prepare(`INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at) VALUES ('sq1', ?, ?, 'scheduled', ?, 0)`).bind(uid, JSON.stringify({ subject: '排程的信' }), FROM + 15 * H).run();
    // 窗外 / 不該出現
    await env.DB.prepare(`INSERT INTO calendar_events (id, user_id, uid, summary, start_ms, created_at) VALUES ('ev2', ?, 'uid2', '明天的會', ?, 0)`).bind(uid, TO + H).run();
    await env.DB.prepare(`INSERT INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, status, created_at) VALUES ('fu3', ?, 'm-done', 't-d', '已完成', ?, 0, 'done', 0)`).bind(uid, FROM + 5 * H).run();
    await env.DB.prepare(`INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, snoozed_until, received_at, created_at) VALUES ('m-tmr', ?, 't2', 'inbound', 'b@x.com', '小華', '明天醒', '', 'inbox', ?, 0, 0)`).bind(uid, TO + H).run();
    await env.DB.prepare(`INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at) VALUES ('sq2', ?, ?, 'sent', ?, 0)`).bind(uid, JSON.stringify({ subject: '已寄' }), FROM + 6 * H).run();

    const items = await buildAgenda(env, uid, FROM, TO);
    expect(items.map((i) => i.kind)).toEqual(['followup', 'event', 'followup', 'snooze', 'scheduled']);
    expect(items[0]).toMatchObject({ kind: 'followup', overdue: true, messageId: 'm-over' });
    expect(items[2]).toMatchObject({ kind: 'followup', overdue: false, title: '今日跟進' });
    expect(items[1]).toMatchObject({ kind: 'event', title: '晨會', url: '/#calendar' });
    expect(items[3]).toMatchObject({ kind: 'snooze', title: '稍後處理的信', sub: '小明', messageId: 'm-snz' });
    expect(items[4]).toMatchObject({ kind: 'scheduled', title: '排程的信' });
  });

  it('buildAgenda：展開重複事件的今日落點（base 早於今日）', async () => {
    const u = await seedUser(env, 'r@miseroda.com');
    const base = FROM - 3 * 86_400_000 + 8 * H; // 三天前 08:00 起，每日重複
    await env.DB.prepare(`INSERT INTO calendar_events (id, user_id, uid, summary, start_ms, rrule, created_at) VALUES ('rec', ?, 'r1', '每日站會', ?, 'FREQ=DAILY', 0)`).bind(u.userId, base).run();
    const events = (await buildAgenda(env, u.userId, FROM, TO)).filter((i) => i.kind === 'event');
    expect(events).toEqual([expect.objectContaining({ kind: 'event', at: FROM + 8 * H, title: '每日站會' })]);
  });

  it('buildAgenda：按使用者隔離', async () => {
    const a = await seedUser(env, 'a@miseroda.com');
    const b = await seedUser(env, 'b@miseroda.com');
    await env.DB.prepare(`INSERT INTO calendar_events (id, user_id, uid, summary, start_ms, created_at) VALUES ('e', ?, 'x', 'A 的會', ?, 0)`).bind(a.userId, FROM + H).run();
    expect((await buildAgenda(env, a.userId, FROM, TO)).length).toBe(1);
    expect((await buildAgenda(env, b.userId, FROM, TO)).length).toBe(0);
  });
});
