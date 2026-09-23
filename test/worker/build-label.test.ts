// 頭像選單最底下的版本標籤（Hon 2026-09-23 定案）：PWA 確認有沒有更新到。
import { describe, expect, it } from 'vitest';
import { formatBuildLabel } from '../../src/app/lib/buildLabel';

describe('formatBuildLabel', () => {
  it('commit 時間換成當地時間、編號取 7 碼', () => {
    expect(formatBuildLabel('4231ac2f00', '2026-09-23T09:58:12-07:00', 'Asia/Taipei')).toBe('版本 09/24 00:58 · 4231ac2');
    expect(formatBuildLabel('4231ac2', '2026-09-23T09:58:12-07:00', 'America/Los_Angeles')).toBe('版本 09/23 09:58 · 4231ac2');
  });
  it('午夜顯示 00 不是 24', () => {
    expect(formatBuildLabel('abc1234', '2026-09-23T16:05:00Z', 'Asia/Taipei')).toBe('版本 09/24 00:05 · abc1234');
  });
  it('建置環境拿不到 commit 時間 → 只顯示編號；拿不到編號 → dev', () => {
    expect(formatBuildLabel('abc1234', '')).toBe('版本 abc1234');
    expect(formatBuildLabel('abc1234', 'not-a-date')).toBe('版本 abc1234');
    expect(formatBuildLabel('', '')).toBe('版本 dev');
  });
});
