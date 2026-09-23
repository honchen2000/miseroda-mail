// F17.1：撰寫視窗展開上限的純邏輯（src/app/composerWins.ts）。
// 這是多實例撰寫器裡唯一可單測的部分——其餘（per-win 自動儲存、依 key 關窗/寄出）
// 都綁 React 狀態，專案無前端測試設施，只能由 Hon 實機走查。
import { describe, expect, it } from 'vitest';
import { enforceExpandLimit } from '../../src/app/composerWins';

const w = (key: string, minimized: boolean, activeAt: number) => ({ key, minimized, activeAt });

describe('撰寫視窗展開上限', () => {
  it('沒超過上限 → 原樣回傳同一個陣列參考（不觸發無謂 re-render）', () => {
    const ws = [w('a', false, 100)];
    expect(enforceExpandLimit(ws, 1)).toBe(ws);
    const two = [w('a', false, 100), w('b', true, 200)];
    expect(enforceExpandLimit(two, 1)).toBe(two); // 收起的不算進上限
  });

  it('上限 1：開第二扇時，最久沒互動的那扇被收起', () => {
    const out = enforceExpandLimit([w('old', false, 100), w('new', false, 200)], 1);
    expect(out.find((x) => x.key === 'old')!.minimized).toBe(true);
    expect(out.find((x) => x.key === 'new')!.minimized).toBe(false);
  });

  it('上限 2（F17.2 會用到）：三扇展開只收起最舊那一扇', () => {
    const out = enforceExpandLimit([w('a', false, 100), w('b', false, 300), w('c', false, 200)], 2);
    expect(out.map((x) => [x.key, x.minimized])).toEqual([['a', true], ['b', false], ['c', false]]);
  });

  it('已收起的視窗不會被「解除收起」，也不佔展開額度', () => {
    const out = enforceExpandLimit([w('zzz', true, 999), w('a', false, 100), w('b', false, 200)], 1);
    expect(out.find((x) => x.key === 'zzz')!.minimized).toBe(true); // 仍收起，沒被 activeAt 最大值拉回來
    expect(out.find((x) => x.key === 'b')!.minimized).toBe(false);
    expect(out.find((x) => x.key === 'a')!.minimized).toBe(true);
  });
});
