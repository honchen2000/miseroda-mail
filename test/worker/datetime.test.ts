// 日期選擇器純函式測試（與原生 input 字串格式一致 + 月曆格正確）。
import { describe, expect, it } from 'vitest';
import { displayLocal, formatLocal, monthGrid, parseLocal } from '../../src/app/lib/datetime';

describe('datetime helpers', () => {
  it('parseLocal：datetime / date / 無效與越界', () => {
    expect(parseLocal('2026-06-20T14:30')).toEqual({ y: 2026, mo: 6, d: 20, h: 14, mi: 30 });
    expect(parseLocal('2026-06-20')).toEqual({ y: 2026, mo: 6, d: 20, h: 0, mi: 0 });
    expect(parseLocal('')).toBeNull();
    expect(parseLocal(null)).toBeNull();
    expect(parseLocal('nope')).toBeNull();
    expect(parseLocal('2026-13-01')).toBeNull(); // 月份越界
    expect(parseLocal('2026-06-20T25:00')).toBeNull(); // 小時越界
  });

  it('formatLocal：與原生 input 字串一致 + round-trip', () => {
    const p = { y: 2026, mo: 6, d: 5, h: 9, mi: 5 };
    expect(formatLocal(p, 'datetime')).toBe('2026-06-05T09:05');
    expect(formatLocal(p, 'date')).toBe('2026-06-05');
    expect(formatLocal(parseLocal('2026-01-02T03:04')!, 'datetime')).toBe('2026-01-02T03:04');
  });

  it('displayLocal：人類可讀', () => {
    expect(displayLocal({ y: 2026, mo: 6, d: 5, h: 9, mi: 5 }, 'datetime')).toBe('2026/06/05 09:05');
    expect(displayLocal({ y: 2026, mo: 6, d: 5, h: 9, mi: 5 }, 'date')).toBe('2026/06/05');
    expect(displayLocal(null, 'date')).toBe('');
  });

  it('minSchedule 風格：本地時間 round-trip 不偏移（修 toISOString 在 UTC+8 排到過去的 bug）', () => {
    const d = new Date(2026, 5, 20, 14, 30); // 本地 2026/06/20 14:30
    const s = formatLocal({ y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() }, 'datetime');
    const back = new Date(s); // 不帶時區的字串以本地解析
    expect(back.getFullYear()).toBe(2026);
    expect(back.getHours()).toBe(14);
    expect(back.getMinutes()).toBe(30);
  });

  it('monthGrid：42 格、補滿前後月、週日為首', () => {
    const g = monthGrid(2026, 5); // 2026 年 6 月（month0=5）
    expect(g.length).toBe(42);
    expect(g[0]).toMatchObject({ y: 2026, mo: 5, d: 31, inMonth: false, key: '2026-05-31' }); // 6/1 為週一 → 首格 5/31（週日）
    expect(g[1]).toMatchObject({ y: 2026, mo: 6, d: 1, inMonth: true });
    expect(g.find((c) => c.mo === 6 && c.d === 30)?.inMonth).toBe(true);
  });
});
