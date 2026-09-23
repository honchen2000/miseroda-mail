// F4.5b：把扁平標籤清單組成 2 層樹（純函式，可被 worker vitest 測）。
// 後端已依 sort_order, created_at 排序 → 此處保留輸入順序，只做父子分組。
export interface FlatLabel {
  id: string;
  name: string;
  color: string;
  count: number;
  parentId: string | null;
  sortOrder: number;
}
export interface LabelNode extends FlatLabel {
  children: FlatLabel[];
}

/**
 * 組樹：頂層標籤（parentId=null）為節點，其 children 為指向它的子標籤（保留輸入順序）。
 * 孤兒（parentId 指向不存在/非頂層的標籤）視為頂層，避免漏顯示。
 */
export function buildLabelTree(labels: FlatLabel[]): LabelNode[] {
  const topIds = new Set(labels.filter((l) => l.parentId === null).map((l) => l.id));
  const childrenByParent = new Map<string, FlatLabel[]>();
  for (const l of labels) {
    if (l.parentId !== null && topIds.has(l.parentId)) {
      const arr = childrenByParent.get(l.parentId) ?? [];
      arr.push(l);
      childrenByParent.set(l.parentId, arr);
    }
  }
  const nodes: LabelNode[] = [];
  for (const l of labels) {
    // 頂層，或孤兒（父不存在/父非頂層）→ 當頂層節點顯示
    if (l.parentId === null || !topIds.has(l.parentId)) {
      nodes.push({ ...l, children: childrenByParent.get(l.id) ?? [] });
    }
  }
  return nodes;
}
