// 日期/時間選擇器的純函式（無 DOM，可在 worker 環境單測）。
// 一律處理「本地牆鐘」欄位，輸出與原生 <input type=date/datetime-local> 完全相同的字串格式，
// 讓周邊既有邏輯（new Date(value).getTime() 等）零改動。

export interface DateParts {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number; // 0-23
  mi: number; // 0-59
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 解析 YYYY-MM-DD 或 YYYY-MM-DDThh:mm（本地牆鐘）→ 各欄位；格式不符回 null。 */
export function parseLocal(s: string | null | undefined): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const p = { y: +y, mo: +mo, d: +d, h: h ? +h : 0, mi: mi ? +mi : 0 };
  // 基本範圍守門（不臆測進位）
  if (p.mo < 1 || p.mo > 12 || p.d < 1 || p.d > 31 || p.h > 23 || p.mi > 59) return null;
  return p;
}

/** 各欄位 → 字串。mode='date' → YYYY-MM-DD；'datetime' → YYYY-MM-DDThh:mm。 */
export function formatLocal(p: DateParts, mode: 'date' | 'datetime'): string {
  const day = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  return mode === 'date' ? day : `${day}T${pad(p.h)}:${pad(p.mi)}`;
}

/** 人類可讀顯示（觸發按鈕用）。 */
export function displayLocal(p: DateParts | null, mode: 'date' | 'datetime'): string {
  if (!p) return '';
  const day = `${p.y}/${pad(p.mo)}/${pad(p.d)}`;
  return mode === 'date' ? day : `${day} ${pad(p.h)}:${pad(p.mi)}`;
}

export interface GridCell {
  y: number;
  mo: number; // 1-12
  d: number;
  inMonth: boolean;
  key: string; // YYYY-MM-DD
}

/** 某年某月（month0 為 0-11）的月曆格：補滿前後月共 42 格（6 週），週日為週首。 */
export function monthGrid(year: number, month0: number): GridCell[] {
  const startDow = new Date(year, month0, 1).getDay(); // 0=Sun
  const cells: GridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(year, month0, 1 - startDow + i);
    cells.push({
      y: dt.getFullYear(),
      mo: dt.getMonth() + 1,
      d: dt.getDate(),
      inMonth: dt.getMonth() === month0,
      key: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    });
  }
  return cells;
}
