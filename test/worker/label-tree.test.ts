// F4.5b：buildLabelTree 純函式（2 層分組 + 孤兒提頂層）。
import { describe, expect, it } from 'vitest';
import { buildLabelTree } from '../../src/app/lib/labelTree';

const L = (id: string, parentId: string | null = null, sortOrder = 0) => ({ id, name: id, color: '#fff', count: 0, parentId, sortOrder });

describe('buildLabelTree（F4.5b）', () => {
  it('2 層分組：頂層 + 子標籤', () => {
    const tree = buildLabelTree([L('bill'), L('util', 'bill'), L('work')]);
    expect(tree.map((n) => n.id)).toEqual(['bill', 'work']);
    expect(tree.find((n) => n.id === 'bill')!.children.map((c) => c.id)).toEqual(['util']);
    expect(tree.find((n) => n.id === 'work')!.children).toEqual([]);
  });
  it('保留輸入順序（後端已依 sort_order 排序）', () => {
    const tree = buildLabelTree([L('a'), L('b'), L('a1', 'a'), L('a2', 'a')]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree[0].children.map((c) => c.id)).toEqual(['a1', 'a2']);
  });
  it('孤兒（父不存在或非頂層）提為頂層，不漏顯示', () => {
    const t1 = buildLabelTree([L('x', 'ghost'), L('y')]);
    expect(t1.map((n) => n.id).sort()).toEqual(['x', 'y']);
    // gc 的父 c 本身是子（非頂層）→ gc 提頂層；c 仍是 p 的子
    const t2 = buildLabelTree([L('p'), L('c', 'p'), L('gc', 'c')]);
    expect(t2.find((n) => n.id === 'p')!.children.map((c) => c.id)).toEqual(['c']);
    expect(t2.find((n) => n.id === 'gc')).toBeTruthy();
  });
});
