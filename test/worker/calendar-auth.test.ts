// F16.1 / 2026-09-20 安全掃描 F1/F4/F5：收到的 .ics 不得只憑 UID 就改掉別人的行事曆。
// 測試情境逐條對應 docs/product-roadmap.md F16.1 的「驗證」欄——特別是前兩輪修補被擋下的兩個誤殺情境
//（中繼／代寄改期要能進來、原信被 purge 掉之後事件仍要改得動），它們和「陌生人改不動」同等重要。
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertCalendarEvent } from '../../src/worker/email/calendarStore';
import type { CalendarEvent } from '../../src/worker/email/calendar';
import { seedUser } from './helpers/fixtures';

const uniq = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    method: 'REQUEST',
    summary: '專案同步',
    startText: '2026/10/01 09:00',
    endText: null,
    startMs: Date.UTC(2026, 9, 1, 9, 0),
    endMs: null,
    allDay: false,
    location: '台北 3F',
    description: null,
    organizer: { name: null, email: 'boss@example.com' },
    uid: 'cal-fixed@miseroda.com',
    rrule: null,
    sequence: 0,
    ...over,
  };
}

type Row = { summary: string; start_ms: number; location: string; organizer: string; auth_addr: string; seq: number; source: string; blocked_at: number | null; blocked_by: string };
const read = (uid: string) =>
  env.DB.prepare(`SELECT summary, start_ms, location, organizer, auth_addr, seq, source, blocked_at, blocked_by FROM calendar_events WHERE uid = ?`)
    .bind(uid)
    .first<Row>();

describe('行事曆寫入授權（F16.1）', () => {
  it('陌生人照抄 ORGANIZER 也改不動：內容原封不動，並留下使用者看得見的被拒訊號', async () => {
    const u = await seedUser(env, `cal1-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    expect(await upsertCalendarEvent(env, u.userId, ev({ uid }), { source: 'received', authAddr: 'boss@example.com' })).toBe('inserted');

    // 攻擊者把 ORGANIZER 照抄成 boss@example.com，但信是自己寄的
    const out = await upsertCalendarEvent(
      env,
      u.userId,
      ev({ uid, summary: '改期：改到台北車站', startMs: Date.UTC(2026, 11, 1, 3, 0), location: '台北車站' }),
      { source: 'received', authAddr: 'mallory@evil.example' },
    );
    expect(out).toBe('blocked');

    const r = (await read(uid))!;
    expect(r.summary).toBe('專案同步'); // 內容原封不動
    expect(r.start_ms).toBe(Date.UTC(2026, 9, 1, 9, 0));
    expect(r.location).toBe('台北 3F');
    expect(r.blocked_at).toBeGreaterThan(0); // 使用者看得見的訊號
    expect(r.blocked_by).toBe('mallory@evil.example');
  });

  it('原 organizer 改期生效，並清掉先前的被拒警示', async () => {
    const u = await seedUser(env, `cal2-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    await upsertCalendarEvent(env, u.userId, ev({ uid }), { source: 'received', authAddr: 'boss@example.com' });
    await upsertCalendarEvent(env, u.userId, ev({ uid }), { source: 'received', authAddr: 'mallory@evil.example' }); // 先製造一個警示

    const out = await upsertCalendarEvent(env, u.userId, ev({ uid, summary: '專案同步（改期）', startMs: Date.UTC(2026, 9, 2, 9, 0) }), {
      source: 'received',
      authAddr: 'BOSS@Example.com ', // 大小寫與空白都應正規化
    });
    expect(out).toBe('updated');

    const r = (await read(uid))!;
    expect(r.summary).toBe('專案同步（改期）');
    expect(r.start_ms).toBe(Date.UTC(2026, 9, 2, 9, 0));
    expect(r.blocked_at).toBeNull(); // 合法更新進來 → 陳舊警示清掉
    expect(r.blocked_by).toBe('');
  });

  it('中繼／代寄改期進得來：auth_addr 認的是原始寄件者，不是 ORGANIZER（前一輪的誤殺情境）', async () => {
    const u = await seedUser(env, `cal3-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    // 訂票系統的 noreply 中繼寄出，.ics 裡的 ORGANIZER 掛的是真人
    await upsertCalendarEvent(env, u.userId, ev({ uid }), { source: 'received', authAddr: 'noreply@relay.example' });
    expect((await read(uid))!.auth_addr).toBe('noreply@relay.example');

    const out = await upsertCalendarEvent(env, u.userId, ev({ uid, summary: '航班改期' }), {
      source: 'received',
      authAddr: 'noreply@relay.example',
    });
    expect(out).toBe('updated');
    expect((await read(uid))!.summary).toBe('航班改期');
  });

  it('原信被 purge 掉之後仍改得動：授權位址存在 calendar_events 自己身上（前一輪的死鎖情境）', async () => {
    const u = await seedUser(env, `cal4-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    const msgId = `msg-${uniq()}`;
    await upsertCalendarEvent(env, u.userId, ev({ uid }), { source: 'received', authAddr: 'boss@example.com', messageId: msgId });

    // 模擬 lib/purge.ts 硬刪 messages（本來就不存在對應列，這裡明確表達「原信已不可得」）
    await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(msgId).run();

    const out = await upsertCalendarEvent(env, u.userId, ev({ uid, summary: '仍可更新' }), {
      source: 'received',
      authAddr: 'boss@example.com',
    });
    expect(out).toBe('updated');
    expect((await read(uid))!.summary).toBe('仍可更新');
  });

  it('SEQUENCE 倒退被拒（重放舊 .ics 把時間改回去）；相同或更高則放行', async () => {
    const u = await seedUser(env, `cal5-${uniq()}@miseroda.com`);
    const uid = `uid-${uniq()}@x`;
    await upsertCalendarEvent(env, u.userId, ev({ uid, sequence: 5, summary: 'v5' }), { source: 'received', authAddr: 'boss@example.com' });

    expect(await upsertCalendarEvent(env, u.userId, ev({ uid, sequence: 4, summary: 'v4 重放' }), { source: 'received', authAddr: 'boss@example.com' })).toBe('blocked');
    expect((await read(uid))!.summary).toBe('v5');

    expect(await upsertCalendarEvent(env, u.userId, ev({ uid, sequence: 5, summary: 'v5 修正' }), { source: 'received', authAddr: 'boss@example.com' })).toBe('updated');
    expect(await upsertCalendarEvent(env, u.userId, ev({ uid, sequence: 6, summary: 'v6' }), { source: 'received', authAddr: 'boss@example.com' })).toBe('updated');
    expect((await read(uid))!.seq).toBe(6);
  });

  it('收到的 .ics 永遠改不動使用者自建的事件，即使寄件者位址剛好對得上', async () => {
    const mine = `cal6-${uniq()}@miseroda.com`;
    const u = await seedUser(env, mine);
    const uid = `uid-${uniq()}@x`;
    await upsertCalendarEvent(env, u.userId, ev({ uid, summary: '我自己排的' }), { source: 'created', authAddr: mine });
    expect((await read(uid))!.source).toBe('created');

    const out = await upsertCalendarEvent(env, u.userId, ev({ uid, summary: '被改掉了' }), {
      source: 'received',
      authAddr: mine,
    });
    expect(out).toBe('blocked');
    const r = (await read(uid))!;
    expect(r.summary).toBe('我自己排的');
    expect(r.source).toBe('created'); // source 仍是插入時的值，upsert 永不更新它
  });
});
