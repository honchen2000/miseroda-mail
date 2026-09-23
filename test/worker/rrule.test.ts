// RRULE 展開器純單元測試（最高風險、覆蓋日曆邊界）。
import { describe, expect, it } from 'vitest';
import { computeReminderNextMs, expandOccurrences, nextOccurrenceFrom, parseRrule } from '../../src/worker/email/rrule';

const U = Date.UTC;
const DAY = 86400_000;

describe('parseRrule', () => {
  it('解析常見欄位', () => {
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5')).toEqual({
      freq: 'WEEKLY', interval: 2, byday: [1, 3], count: 5, until: null,
    });
    expect(parseRrule('FREQ=DAILY')).toEqual({ freq: 'DAILY', interval: 1, byday: null, count: null, until: null });
  });
  it('無 FREQ / 空字串 / 亂碼 → null', () => {
    expect(parseRrule('')).toBeNull();
    expect(parseRrule(null)).toBeNull();
    expect(parseRrule('INTERVAL=2')).toBeNull();
    expect(parseRrule('FREQ=HOURLY')).toBeNull(); // 不支援 → null
  });
});

describe('expandOccurrences', () => {
  it('DAILY：逐日，rangeTo 不含端點', () => {
    const start = U(2026, 0, 1, 9, 0);
    const occ = expandOccurrences(start, parseRrule('FREQ=DAILY')!, start, U(2026, 0, 4));
    expect(occ).toEqual([U(2026, 0, 1, 9, 0), U(2026, 0, 2, 9, 0), U(2026, 0, 3, 9, 0)]);
  });
  it('WEEKLY：每 7 天；INTERVAL=2 每 14 天', () => {
    const start = U(2026, 0, 5, 10, 0); // 週一
    expect(expandOccurrences(start, parseRrule('FREQ=WEEKLY')!, start, U(2026, 1, 1))).toEqual([
      U(2026, 0, 5, 10, 0), U(2026, 0, 12, 10, 0), U(2026, 0, 19, 10, 0), U(2026, 0, 26, 10, 0),
    ]);
    expect(expandOccurrences(start, parseRrule('FREQ=WEEKLY;INTERVAL=2')!, start, U(2026, 1, 1))).toEqual([
      U(2026, 0, 5, 10, 0), U(2026, 0, 19, 10, 0),
    ]);
  });
  it('WEEKLY BYDAY=MO,WE,FR：首週只取 >= DTSTART 的星期幾', () => {
    const start = U(2026, 0, 7, 10, 0); // 週三
    const occ = expandOccurrences(start, parseRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR')!, start, U(2026, 0, 13));
    // 首週（週日 1/4）：週一 1/5 < start 略過；週三 1/7、週五 1/9；下週一 1/12
    expect(occ).toEqual([U(2026, 0, 7, 10, 0), U(2026, 0, 9, 10, 0), U(2026, 0, 12, 10, 0)]);
  });
  it('MONTHLY：保持日；無此日（31）的月份跳過、不計 COUNT', () => {
    const start = U(2026, 0, 31, 9, 0);
    const occ = expandOccurrences(start, parseRrule('FREQ=MONTHLY')!, start, U(2026, 5, 1));
    expect(occ).toEqual([U(2026, 0, 31, 9, 0), U(2026, 2, 31, 9, 0), U(2026, 4, 31, 9, 0)]); // 1/31, 3/31, 5/31（2/4 月跳過）
  });
  it('YEARLY：2/29 只在閏年出現', () => {
    const start = U(2024, 1, 29, 9, 0);
    const occ = expandOccurrences(start, parseRrule('FREQ=YEARLY')!, start, U(2029, 0, 1));
    expect(occ).toEqual([U(2024, 1, 29, 9, 0), U(2028, 1, 29, 9, 0)]);
  });
  it('COUNT 限制總次數；UNTIL 含當日', () => {
    const start = U(2026, 0, 1, 9, 0);
    expect(expandOccurrences(start, parseRrule('FREQ=DAILY;COUNT=3')!, start, start + 100 * DAY).length).toBe(3);
    const u = expandOccurrences(start, parseRrule('FREQ=DAILY;UNTIL=20260103')!, start, start + 100 * DAY);
    expect(u).toEqual([U(2026, 0, 1, 9, 0), U(2026, 0, 2, 9, 0), U(2026, 0, 3, 9, 0)]); // 1/3 23:59 為界
  });
  it('範圍過濾：只回傳落在 [from,to) 的場次', () => {
    const start = U(2026, 0, 1, 9, 0);
    const occ = expandOccurrences(start, parseRrule('FREQ=DAILY')!, U(2026, 0, 3), U(2026, 0, 6));
    expect(occ).toEqual([U(2026, 0, 3, 9, 0), U(2026, 0, 4, 9, 0), U(2026, 0, 5, 9, 0)]);
  });
});

describe('nextOccurrenceFrom / computeReminderNextMs', () => {
  it('nextOccurrenceFrom：嚴格晚於 after 的最近場次', () => {
    const start = U(2026, 0, 1, 9, 0);
    const rule = parseRrule('FREQ=WEEKLY')!;
    expect(nextOccurrenceFrom(start, rule, start)).toBe(U(2026, 0, 8, 9, 0)); // 不含自身
    expect(nextOccurrenceFrom(start, rule, start - 1)).toBe(start);
  });
  it('computeReminderNextMs：單次未來 = start - 提前量；過去 = null；無提醒 = null', () => {
    const now = U(2026, 0, 1, 8, 0);
    expect(computeReminderNextMs(U(2026, 0, 1, 9, 0), null, 15, now)).toBe(U(2026, 0, 1, 8, 45));
    expect(computeReminderNextMs(U(2026, 0, 1, 7, 0), null, 15, now)).toBeNull(); // 已過
    expect(computeReminderNextMs(U(2026, 0, 1, 9, 0), null, null, now)).toBeNull(); // 不提醒
  });
  it('computeReminderNextMs：重複事件 base 在過去 → 取下個未來場次', () => {
    const now = U(2026, 0, 1, 8, 0);
    const base = U(2025, 11, 31, 9, 0); // 昨天 09:00
    expect(computeReminderNextMs(base, parseRrule('FREQ=DAILY'), 0, now)).toBe(U(2026, 0, 1, 9, 0)); // 今天 09:00
  });
});
