// F2.4：AI 從信件抽會議/待辦。AI 呼叫本身非確定性（Workers AI、測試環境無）不在此測；
// 這裡測「模型回傳的台北牆鐘字串 → UTC epoch ms」這條純函式換算（時區是最易錯處）。
import { describe, expect, it } from 'vitest';
import { parseTaipeiLocal } from '../../src/worker/api/ai';

describe('parseTaipeiLocal（F2.4 台北牆鐘 → UTC ms）', () => {
  it('下午三點台北 = 當日 07:00 UTC（空白與 T 分隔皆可）', () => {
    expect(parseTaipeiLocal('2026-06-30 15:00')).toBe(Date.UTC(2026, 5, 30, 7, 0));
    expect(parseTaipeiLocal('2026-06-30T15:00')).toBe(Date.UTC(2026, 5, 30, 7, 0));
  });
  it('凌晨換日：台北 03:00 = 前一日 19:00 UTC', () => {
    expect(parseTaipeiLocal('2026-06-30 03:00')).toBe(Date.UTC(2026, 5, 29, 19, 0));
  });
  it('斜線格式正規化：2026/06/30 → 同等解析', () => {
    expect(parseTaipeiLocal('2026/06/30 15:00')).toBe(Date.UTC(2026, 5, 30, 7, 0));
  });
  it('日期溢位（2/30、4/31）→ null（回環驗證擋 Date.UTC 靜默進位）', () => {
    expect(parseTaipeiLocal('2026-02-30 09:00')).toBeNull();
    expect(parseTaipeiLocal('2026-04-31 09:00')).toBeNull();
  });
  it('格式錯 / 月時分超界 → null', () => {
    expect(parseTaipeiLocal('下週二下午三點')).toBeNull();
    expect(parseTaipeiLocal('2026-13-01 00:00')).toBeNull();
    expect(parseTaipeiLocal('2026-06-30 25:00')).toBeNull();
    expect(parseTaipeiLocal('2026-06-30 12:70')).toBeNull();
    expect(parseTaipeiLocal('')).toBeNull();
  });
});
