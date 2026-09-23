// 列表樂觀更新純函式（patchMessagePages）——這正是 ④a 漏掉、導致星標/已讀/封存等全失效的那段。
// 對 infinite-query 的 { pages: [{items}] } 結構運作；守門永不 throw。
import { describe, expect, it } from 'vitest';
import { patchMessagePages, type InfinitePages } from '../../src/app/api/optimistic';

interface Item { id: string; unread: boolean; starred: boolean; status?: 'needs_reply' | 'waiting' | null; pinned?: boolean }
const item = (id: string, o: Partial<Item> = {}): Item => ({ id, unread: true, starred: false, ...o });
const data = (...pageItems: Item[][]): InfinitePages<Item> => ({
  pages: pageItems.map((items) => ({ items, nextCursor: null })),
  pageParams: [null],
});

describe('patchMessagePages (optimistic list update)', () => {
  it('star/unread update the item in place, keep it in the list', () => {
    const d = data([item('a'), item('b')]);
    const starred = patchMessagePages(d, 'a', { starred: true })!;
    expect(starred.pages[0].items.map((m) => m.id)).toEqual(['a', 'b']); // 仍在列表
    expect(starred.pages[0].items[0].starred).toBe(true);
    expect(starred.pages[0].items[1].starred).toBe(false); // 別封不動

    const read = patchMessagePages(d, 'b', { unread: false })!;
    expect(read.pages[0].items.find((m) => m.id === 'b')!.unread).toBe(false);
    expect(read.pages[0].items.find((m) => m.id === 'a')!.unread).toBe(true);
  });

  it('status / pinned update in place, keep the item in the list (like star)', () => {
    const d = data([item('a'), item('b')]);
    const s = patchMessagePages(d, 'a', { status: 'needs_reply' })!;
    expect(s.pages[0].items.map((m) => m.id)).toEqual(['a', 'b']); // 不移出視圖
    expect(s.pages[0].items[0].status).toBe('needs_reply');
    const p = patchMessagePages(d, 'b', { pinned: true })!;
    expect(p.pages[0].items.find((m) => m.id === 'b')!.pinned).toBe(true);
    expect(p.pages[0].items.find((m) => m.id === 'a')!.pinned).toBeUndefined(); // 別封不動
  });

  it('folder / snooze / category remove the item from the current view', () => {
    const d = data([item('a'), item('b'), item('c')]);
    for (const patch of [{ folder: 'archive' }, { snoozedUntil: 123 }, { category: 'social' }] as const) {
      const out = patchMessagePages(d, 'b', patch)!;
      expect(out.pages[0].items.map((m) => m.id)).toEqual(['a', 'c']); // b 移出
    }
  });

  it('updates an item on a later page (multi-page infinite query)', () => {
    const d = data([item('a')], [item('b'), item('c')]);
    const out = patchMessagePages(d, 'c', { starred: true })!;
    expect(out.pages[1].items.find((m) => m.id === 'c')!.starred).toBe(true);
    expect(out.pages[0].items[0].id).toBe('a'); // 第一頁不動
  });

  it('never throws on undefined / non-infinite shapes (defensive)', () => {
    expect(patchMessagePages(undefined, 'a', { starred: true })).toBeUndefined();
    // 舊 useQuery 結構（無 pages）：原樣回傳，不丟錯
    const legacy = { items: [item('a')] } as unknown as InfinitePages<Item>;
    expect(patchMessagePages(legacy, 'a', { starred: true })).toBe(legacy);
  });

  it('is immutable — does not mutate the input', () => {
    const d = data([item('a', { starred: false })]);
    const before = d.pages[0].items[0].starred;
    patchMessagePages(d, 'a', { starred: true });
    expect(d.pages[0].items[0].starred).toBe(before); // 原物件未被改動
  });
});
