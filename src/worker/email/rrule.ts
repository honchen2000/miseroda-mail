// RFC 5545 RRULE 的小型展開器（純函式、無 I/O，便於單測）。
//
// 支援子集（足夠家庭日常 + 對外部邀請容錯）：FREQ=DAILY/WEEKLY/MONTHLY/YEARLY、INTERVAL、
// BYDAY（週重複指定星期幾）、COUNT、UNTIL。不支援 BYMONTHDAY/BYSETPOS… 等進階規則（遇到就忽略該參數，
// 仍以 FREQ 基本展開，絕不拋例外——對來信邀請寧可少展開也不要爆掉）。
//
// 時間策略：一律以「事件 start_ms 的 UTC 欄位」做日曆運算。對 UTC 事件精確；對 floating（牆鐘存成 UTC 近似）
// 事件則保持牆鐘日/時不漂移。台北無 DST，週/日重複用 epoch 位移不會跨 DST 跳時。

export interface ParsedRrule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number; // >= 1
  byday: number[] | null; // 週重複：0=SU..6=SA；其餘 freq 忽略
  count: number | null; // 總發生次數（含第一次）
  until: number | null; // epoch ms（含）；超過即停
}

const DAY_CODE: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 86400_000;
const MAX_STEPS = 3000; // 防呆：任何展開最多迭代這麼多候選，杜絕惡意/異常 RRULE 拖垮 worker

/** 解析 RRULE 值字串（不含 "RRULE:" 前綴）。無法辨識 FREQ → null。 */
export function parseRrule(value: string | null | undefined): ParsedRrule | null {
  if (!value) return null;
  const parts: Record<string, string> = {};
  for (const seg of value.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).trim();
  }
  const freq = parts.FREQ?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  const interval = Math.max(1, Math.min(1000, Number(parts.INTERVAL) || 1));
  let byday: number[] | null = null;
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',')
      .map((d) => DAY_CODE[d.trim().slice(-2).toUpperCase()]) // 去掉可能的序數前綴（如 2MO），取末兩碼
      .filter((n): n is number => n != null);
    byday = days.length ? [...new Set(days)].sort((a, b) => a - b) : null;
  }
  const count = parts.COUNT && Number(parts.COUNT) > 0 ? Math.min(10000, Number(parts.COUNT)) : null;
  const until = parts.UNTIL ? parseUntil(parts.UNTIL) : null;
  return { freq, interval, byday, count, until };
}

/** UNTIL 值（YYYYMMDD 或 YYYYMMDDTHHMMSSZ）→ epoch ms（含）。純日期視為當日 23:59:59.999。 */
function parseUntil(v: string): number | null {
  const dt = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v.trim());
  if (!dt) return null;
  const [, y, mo, d, h, mi, s] = dt;
  if (h == null) return Date.UTC(+y, +mo - 1, +d, 23, 59, 59, 999);
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

/** base 加 n 個月，保持日/時不變；該月無此日（如 31 號）→ null（該次跳過、不計入 COUNT）。 */
function addMonths(base: number, n: number): number | null {
  const d = new Date(base);
  const monthIdx = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(monthIdx / 12);
  const mo = ((monthIdx % 12) + 12) % 12;
  const cand = Date.UTC(y, mo, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return new Date(cand).getUTCMonth() === mo ? cand : null; // 溢位（31→次月）→ 無效
}

/** base 加 n 年，保持月/日/時；2/29 落非閏年 → null。 */
function addYears(base: number, n: number): number | null {
  const d = new Date(base);
  const cand = Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return new Date(cand).getUTCMonth() === d.getUTCMonth() ? cand : null;
}

/**
 * 依序產生發生時間（含第一次 = startMs），單調遞增。caller 以 yield 順序套用 range/cap。
 * 注意：COUNT 計「有效（非跳過）」發生數；溢位日期不計。
 */
function* occurrences(startMs: number, rule: ParsedRrule): Generator<number> {
  const { freq, interval, byday, count, until } = rule;
  let emitted = 0;

  if (freq === 'WEEKLY' && byday && byday.length) {
    // 以 startMs 所在週的「週日 00:00（牆鐘）」為錨；每 interval 週一個區塊，區塊內依 byday 升序產生。
    const base = new Date(startMs);
    const hh = base.getUTCHours(), mm = base.getUTCMinutes(), ss = base.getUTCSeconds();
    const weekSundayMidnight = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - base.getUTCDay());
    let block = 0;
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      const blockStart = weekSundayMidnight + block * interval * 7 * DAY_MS;
      let any = false;
      for (const dow of byday) {
        const occ = blockStart + dow * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
        any = true;
        if (occ < startMs) continue; // 第一週早於 DTSTART 的星期幾不算
        if (until != null && occ > until) return;
        if (count != null && emitted >= count) return;
        emitted++;
        yield occ;
      }
      if (!any) return;
      block++;
    }
    return;
  }

  // DAILY / WEEKLY(無 byday) / MONTHLY / YEARLY：線性，每步一個候選。
  for (let k = 0, steps = 0; steps < MAX_STEPS; k++, steps++) {
    let occ: number | null;
    if (freq === 'DAILY') occ = startMs + k * interval * DAY_MS;
    else if (freq === 'WEEKLY') occ = startMs + k * interval * 7 * DAY_MS;
    else if (freq === 'MONTHLY') occ = addMonths(startMs, k * interval);
    else occ = addYears(startMs, k * interval);
    if (occ == null) continue; // 溢位日期：跳過、不計 COUNT、不前進 emitted
    if (until != null && occ > until) return;
    if (count != null && emitted >= count) return;
    emitted++;
    yield occ;
  }
}

/** 展開落在 [rangeFrom, rangeTo) 的所有發生時間（含 startMs 本身若在範圍內）。最多回傳 cap 筆。 */
export function expandOccurrences(
  startMs: number,
  rule: ParsedRrule,
  rangeFrom: number,
  rangeTo: number,
  cap = 366,
): number[] {
  const out: number[] = [];
  for (const occ of occurrences(startMs, rule)) {
    if (occ >= rangeTo) break; // 單調遞增 → 越界即止
    if (occ >= rangeFrom) {
      out.push(occ);
      if (out.length >= cap) break;
    }
  }
  return out;
}

/** 嚴格晚於 afterMs 的最近一次發生；無（受 count/until 限制）→ null。 */
export function nextOccurrenceFrom(startMs: number, rule: ParsedRrule, afterMs: number): number | null {
  for (const occ of occurrences(startMs, rule)) {
    if (occ > afterMs) return occ;
  }
  return null;
}

/**
 * 算出「下次提醒」的 epoch ms：取 start >= now 的最近一次發生，減去提前量；無未來發生 → null。
 * reminderMin == null → 不提醒（null）。
 */
export function computeReminderNextMs(
  startMs: number,
  rule: ParsedRrule | null,
  reminderMin: number | null,
  now: number,
): number | null {
  if (reminderMin == null) return null;
  const offset = reminderMin * 60_000;
  let occStart: number | null;
  if (!rule) occStart = startMs >= now ? startMs : null;
  else occStart = startMs >= now ? startMs : nextOccurrenceFrom(startMs, rule, now - 1);
  return occStart == null ? null : occStart - offset;
}
