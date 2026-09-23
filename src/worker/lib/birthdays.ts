// F11.3：聯絡人生日 → 行事曆年度虛擬事件（合成於 /calendar/events 回應，不寫 events 表）。

/** BDAY 常見格式容錯解析 → { month, day }。支援 YYYY-MM-DD / --MM-DD / YYYYMMDD / MM-DD / MM/DD。 */
export function parseBirthday(raw: string): { month: number; day: number } | null {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^\d{4}-(\d{2})-(\d{2})/.exec(s))) return valid(+m[1], +m[2]);
  if ((m = /^--(\d{2})-?(\d{2})$/.exec(s))) return valid(+m[1], +m[2]); // vCard 無年份形式
  if ((m = /^\d{4}(\d{2})(\d{2})$/.exec(s))) return valid(+m[1], +m[2]);
  if ((m = /^(\d{1,2})[-/](\d{1,2})$/.exec(s))) return valid(+m[1], +m[2]);
  return null;
}

function valid(month: number, day: number): { month: number; day: number } | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/**
 * 查詢窗 [fromMs, toMs) 內的生日發生日（UTC 全天 00:00 ms，每年最多一次）。
 * 閏年 2/29 在平年落 2/28（行事曆慣例）。最多回傳 cap 筆（照 expandOccurrences 先例，
 * 防超大窗口逐年展開撐爆記憶體；正常窗口 ≤400 天最多 2 筆，碰不到 cap）。
 */
export function birthdayOccurrences(
  bday: { month: number; day: number },
  fromMs: number,
  toMs: number,
  cap = 366,
): number[] {
  const out: number[] = [];
  const y0 = new Date(fromMs).getUTCFullYear();
  const y1 = new Date(toMs).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    let { month, day } = bday;
    if (month === 2 && day === 29 && !isLeap(y)) day = 28;
    const ms = Date.UTC(y, month - 1, day);
    if (ms >= fromMs && ms < toMs) {
      out.push(ms);
      if (out.length >= cap) break; // 單調遞增 → 滿額即止（同時封住迴圈圈數）
    }
  }
  return out;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
