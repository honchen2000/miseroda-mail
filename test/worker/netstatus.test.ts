// 連線錯誤 toast 橋接的去抖 + 抑制窗邏輯（純模組，無 DOM）。
import { describe, expect, it, beforeEach } from 'vitest';
import { setConnectionErrorHandler, reportConnectionError, markConnectionError, inConnectionErrorWindow } from '../../src/app/api/netstatus';

describe('netstatus reportConnectionError 去抖', () => {
  beforeEach(() => setConnectionErrorHandler(null));

  it('4 秒內只彈一次；超過窗口再彈；未註冊 handler 不炸', () => {
    const seen: string[] = [];
    setConnectionErrorHandler((m) => seen.push(m));
    const t0 = 1_000_000;
    reportConnectionError('連線逾時', t0);
    reportConnectionError('連線逾時', t0 + 1000); // 窗口內 → 略過
    reportConnectionError('連線逾時', t0 + 3999); // 窗口內 → 略過
    expect(seen).toHaveLength(1);
    reportConnectionError('連線逾時', t0 + 4001); // 超過 4s → 再彈
    expect(seen).toHaveLength(2);
  });

  it('未註冊 handler 時安全 no-op', () => {
    setConnectionErrorHandler(null);
    expect(() => reportConnectionError('x', 5_000_000)).not.toThrow();
  });

  it('註冊後移除（null）→ 不再呼叫', () => {
    const seen: string[] = [];
    setConnectionErrorHandler((m) => seen.push(m));
    setConnectionErrorHandler(null);
    reportConnectionError('x', 9_000_000);
    expect(seen).toHaveLength(0);
  });
});

describe('netstatus 連線錯誤抑制窗', () => {
  it('markConnectionError 後 300ms 內為窗內、之後為窗外', () => {
    const t0 = 20_000_000;
    markConnectionError(t0);
    expect(inConnectionErrorWindow(t0)).toBe(true);
    expect(inConnectionErrorWindow(t0 + 299)).toBe(true);
    expect(inConnectionErrorWindow(t0 + 300)).toBe(false); // 邊界外
    expect(inConnectionErrorWindow(t0 + 5000)).toBe(false);
  });

  it('未曾標記 → 遠離初始 0 → 窗外', () => {
    markConnectionError(0); // 重置到 0
    expect(inConnectionErrorWindow(30_000_000)).toBe(false);
  });
});
