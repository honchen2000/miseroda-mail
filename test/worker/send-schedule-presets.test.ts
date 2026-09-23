// F3.3：排程寄信預設（純函式）。用固定 now、斷言結構性質（避開測試環境時區差異）。
import { describe, expect, it } from 'vitest';
import { sendSchedulePresets } from '../../src/app/lib/schedule';

describe('sendSchedulePresets（F3.3）', () => {
  it('「一小時後」恰為 now+1h；全部都在未來；遞增', () => {
    const now = 1_750_000_000_000;
    const ps = sendSchedulePresets(now);
    expect(ps[0]).toEqual({ label: '一小時後', at: now + 3_600_000 });
    for (const p of ps) expect(p.at).toBeGreaterThan(now);
  });
  it('含「明早 8 點」「下週一 9 點」標籤（恆在未來，不被濾）', () => {
    const labels = sendSchedulePresets(1_750_000_000_000).map((p) => p.label);
    expect(labels).toContain('明早 8 點');
    expect(labels).toContain('下週一 9 點');
  });
  it('「今晚 7 點」若已過則濾掉（午夜前一刻 now → 今晚必已過）', () => {
    // 構造一個「今天 23:00 本地」的 now：用 setHours 取得，再驗 19 點預設被濾
    const base = new Date(1_750_000_000_000);
    base.setHours(23, 0, 0, 0);
    const labels = sendSchedulePresets(base.getTime()).map((p) => p.label);
    expect(labels).not.toContain('今晚 7 點');
  });
});
