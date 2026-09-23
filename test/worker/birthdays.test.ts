// F11.3：聯絡人生日入曆 —— 格式容錯 / 閏年 / 跨年窗 / events 端點合成。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { birthdayOccurrences, parseBirthday } from '../../src/worker/lib/birthdays';

describe('F11.3 聯絡人生日入曆', () => {
  it('parseBirthday 格式容錯：ISO / vCard 無年 / 壓縮 / 短格式 / 垃圾回 null', () => {
    expect(parseBirthday('1990-05-12')).toEqual({ month: 5, day: 12 });
    expect(parseBirthday('--05-12')).toEqual({ month: 5, day: 12 });
    expect(parseBirthday('19900512')).toEqual({ month: 5, day: 12 });
    expect(parseBirthday('5/12')).toEqual({ month: 5, day: 12 });
    expect(parseBirthday('12-31')).toEqual({ month: 12, day: 31 });
    expect(parseBirthday('生日快樂')).toBeNull();
    expect(parseBirthday('1990-13-40')).toBeNull();
  });

  it('閏年：2/29 在閏年落 2/29、平年落 2/28；跨年窗每年一次', () => {
    const feb29 = { month: 2, day: 29 };
    // 2028 閏年
    expect(birthdayOccurrences(feb29, Date.UTC(2028, 0, 1), Date.UTC(2028, 11, 31))).toEqual([Date.UTC(2028, 1, 29)]);
    // 2026 平年 → 2/28
    expect(birthdayOccurrences(feb29, Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31))).toEqual([Date.UTC(2026, 1, 28)]);
    // 跨年窗（2026-12 ~ 2027-02）：1/15 生日只出現 2027 那次
    expect(birthdayOccurrences({ month: 1, day: 15 }, Date.UTC(2026, 11, 1), Date.UTC(2027, 1, 28))).toEqual([Date.UTC(2027, 0, 15)]);
    // 12/31 生日在同一跨年窗出現一次（2026 年尾）
    expect(birthdayOccurrences({ month: 12, day: 31 }, Date.UTC(2026, 11, 1), Date.UTC(2027, 1, 28))).toEqual([Date.UTC(2026, 11, 31)]);
  });

  // F7（DoS）：窗口原本無上限 —— 一次 GET 可讓每位有生日的聯絡人逐年展開約 55 萬個物件撐爆 isolate。
  it('birthdayOccurrences：極端窗口受 cap 封頂，不逐年展開', () => {
    const all = birthdayOccurrences({ month: 1, day: 15 }, -8_640_000_000_000_000, 8_640_000_000_000_000);
    expect(all.length).toBeLessThanOrEqual(366);
  });

  it('events 端點：超大窗口截斷為 400 天（仍回 200，不把合法查詢擋掉）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO contacts (user_id, email, custom_name, birthday, created_at, updated_at) VALUES (?, 'mom@example.com', '媽媽', '--07-15', ?, ?)`,
    ).bind(hon.userId, now, now).run();

    // from 起 400 天 = 2027-08-05 → 7/15 生日只該出現 2026、2027 兩次（未截斷時會展開到西元 275760 年）
    const from = Date.UTC(2026, 6, 1);
    const res = await worker.fetch(
      new Request(`https://mail.miseroda.com/api/v1/calendar/events?from=${from}&to=8640000000000000`, {
        headers: { Cookie: `__Host-session=${encodeURIComponent(hon.cookies.session)}; __Host-csrf=${encodeURIComponent(hon.cookies.csrf)}` },
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: { id: string; startMs: number }[] };
    const bday = events.filter((e) => e.id.startsWith('bday:'));
    expect(bday.map((e) => e.startMs)).toEqual([Date.UTC(2026, 6, 15), Date.UTC(2027, 6, 15)]);
  });

  it('events 端點：有生日的聯絡人自動合成 🎂 全天事件；無效生日忽略', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO contacts (user_id, email, custom_name, birthday, created_at, updated_at) VALUES (?, 'mom@example.com', '媽媽', '--07-15', ?, ?)`,
    ).bind(hon.userId, now, now).run();
    await env.DB.prepare(
      `INSERT INTO contacts (user_id, email, custom_name, birthday, created_at, updated_at) VALUES (?, 'bad@example.com', '壞資料', '不是日期', ?, ?)`,
    ).bind(hon.userId, now, now).run();

    const from = Date.UTC(2026, 6, 1);
    const to = Date.UTC(2026, 7, 1);
    const res = await worker.fetch(
      new Request(`https://mail.miseroda.com/api/v1/calendar/events?from=${from}&to=${to}`, {
        headers: { Cookie: `__Host-session=${encodeURIComponent(hon.cookies.session)}; __Host-csrf=${encodeURIComponent(hon.cookies.csrf)}` },
      }),
      env,
      createExecutionContext(),
    );
    const { events } = (await res.json()) as { events: { id: string; summary: string; allDay: boolean; startMs: number }[] };
    const bday = events.filter((e) => e.id.startsWith('bday:'));
    expect(bday.length).toBe(1);
    expect(bday[0].summary).toBe('🎂 媽媽 生日');
    expect(bday[0].allDay).toBe(true);
    expect(bday[0].startMs).toBe(Date.UTC(2026, 6, 15));
  });
});
