// 通知鈴鐺「點開就算看過」（Hon 2026-09-22 定案）。
import { describe, expect, it } from 'vitest';
import { EMPTY_BELL_SEEN, lowerNeedsReply, markBellSeen, normalizeBellSeen, unseenBadge } from '../../src/app/lib/bellSeen';

const a = { id: 'f1', dueAt: 1000 };
const b = { id: 'f2', dueAt: 2000 };

describe('unseenBadge', () => {
  it('從沒點開過 → 與舊行為相同（到期筆數＋有需回信就加 1）', () => {
    expect(unseenBadge([a, b], 3, EMPTY_BELL_SEEN)).toBe(3);
    expect(unseenBadge([a, b], 0, EMPTY_BELL_SEEN)).toBe(2);
  });

  it('點開之後數字歸零（Hon 回報的問題：舊版點開不會消）', () => {
    const seen = markBellSeen([a, b], 3);
    expect(unseenBadge([a, b], 3, seen)).toBe(0);
  });

  it('之後又有新的項目到期 → 只算那一筆', () => {
    const seen = markBellSeen([a], 0);
    expect(unseenBadge([a, b], 0, seen)).toBe(1);
  });

  it('同一筆跟進被延後（dueAt 改變）→ 再次到期時算新的', () => {
    const seen = markBellSeen([a], 0);
    expect(unseenBadge([{ id: 'f1', dueAt: 5000 }], 0, seen)).toBe(1);
  });

  it('需回信：數量超過看過時才加 1；相同或更少都不加', () => {
    const seen = markBellSeen([], 2);
    expect(unseenBadge([], 3, seen)).toBe(1);
    expect(unseenBadge([], 2, seen)).toBe(0);
    expect(unseenBadge([], 1, seen)).toBe(0);
  });

  it('markBellSeen 只記當下到期的項目——不再到期的自然被丟掉，存量有上限', () => {
    expect(markBellSeen([b], 0).keys).toEqual(['f2@2000']);
  });
});

describe('lowerNeedsReply', () => {
  it('回完信（數量變少）→ 門檻跟著調低，之後再變多才會亮', () => {
    const seen = markBellSeen([], 3);
    const lowered = lowerNeedsReply(seen, 1);
    expect(lowered?.needsReply).toBe(1);
    expect(unseenBadge([], 3, lowered!)).toBe(1); // 看過 3 → 回掉 2 → 又來 2：會亮
  });

  it('計數還沒載入（undefined）→ 不動（否則載入中的 0 會讓資料回來時誤亮）', () => {
    expect(lowerNeedsReply(markBellSeen([], 3), undefined)).toBeNull();
  });

  it('相同或更多 → 不需改', () => {
    expect(lowerNeedsReply(markBellSeen([], 3), 3)).toBeNull();
    expect(lowerNeedsReply(markBellSeen([], 3), 5)).toBeNull();
  });
});

describe('normalizeBellSeen', () => {
  it('壞資料一律回空狀態，不丟例外', () => {
    expect(normalizeBellSeen(null)).toEqual(EMPTY_BELL_SEEN);
    expect(normalizeBellSeen('x')).toEqual(EMPTY_BELL_SEEN);
    expect(normalizeBellSeen({ keys: 'no', needsReply: -1 })).toEqual(EMPTY_BELL_SEEN);
    expect(normalizeBellSeen({ keys: ['f1@1', 3], needsReply: 2 })).toEqual({ keys: ['f1@1'], needsReply: 2 });
  });
});
