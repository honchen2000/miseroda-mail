/** 有前綴的唯一 ID，方便除錯與日誌追蹤 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}
