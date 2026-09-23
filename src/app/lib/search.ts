// 搜尋運算子解析（純函式，無 DOM/網路相依 → 可被 worker vitest 直接 import 測）。
// 從 api/mail.ts 抽出（F4.2），新增 larger:/smaller:/older_than:/newer_than:/filename:。

export interface SearchSpec {
  text: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
  isStarred?: boolean;
  label?: string;
  before?: number;
  after?: number;
  larger?: number; // bytes（F4.2）
  smaller?: number; // bytes
  filename?: string; // 附件檔名 LIKE
}

function parseSearchDate(v: string): number | undefined {
  const rel = /^(\d+)d$/.exec(v);
  if (rel) return Date.now() - Number(rel[1]) * 86400000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** 大小 → bytes：5m=5MB、500k=500KB、2g=2GB、純數字=bytes。F4.2 */
export function parseSize(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(v.trim());
  if (!m) return undefined;
  const u = (m[2] ?? 'b').toLowerCase();
  const mult = u.startsWith('g') ? 1024 ** 3 : u.startsWith('m') ? 1024 ** 2 : u.startsWith('k') ? 1024 : 1;
  const bytes = Math.round(Number(m[1]) * mult);
  return bytes > 0 ? bytes : undefined;
}

/** 期間 → ms：1d/1w/1m(=30d)/1y(=365d)。供 older_than:/newer_than:。F4.2 */
export function parseDuration(v: string): number | undefined {
  const m = /^(\d+)\s*(d|w|m|y)$/i.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const day = 86400000;
  const ms = m[2].toLowerCase() === 'd' ? day : m[2].toLowerCase() === 'w' ? 7 * day : m[2].toLowerCase() === 'm' ? 30 * day : 365 * day;
  return n > 0 ? n * ms : undefined;
}

// 上界（before/older_than）取較早者、下界（after/newer_than）取較晚者 → 多重日期條件＝交集（更嚴）。
const tighterBefore = (cur: number | undefined, t: number) => (cur !== undefined ? Math.min(cur, t) : t);
const tighterAfter = (cur: number | undefined, t: number) => (cur !== undefined ? Math.max(cur, t) : t);

/**
 * 解析搜尋運算子：from: to: cc: bcc: subject: has:attachment is:unread|starred label: before: after:
 * larger:/smaller:(5m/500k) older_than:/newer_than:(1y/1w) filename:。
 * （日期支援 7d 或 YYYY-MM-DD）。位址/主旨類運算子的值可用 | 表示「或」，例：from:alice|bob。
 */
export function parseSearch(q: string): SearchSpec {
  const spec: SearchSpec = { text: '' };
  const texts: string[] = [];
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const m = /^([A-Za-z_]+):(.+)$/.exec(tok); // 允許 older_than 等含底線的鍵
    if (!m) {
      texts.push(tok);
      continue;
    }
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === 'from') spec.from = val;
    else if (key === 'to') spec.to = val;
    else if (key === 'cc') spec.cc = val;
    else if (key === 'bcc') spec.bcc = val;
    else if (key === 'subject') spec.subject = val;
    else if (key === 'has' && (val === 'attachment' || val === 'att' || val === '附件')) spec.hasAttachment = true;
    else if (key === 'is' && (val === 'unread' || val === '未讀')) spec.isUnread = true;
    else if (key === 'is' && (val === 'starred' || val === '星標')) spec.isStarred = true;
    else if (key === 'label') spec.label = val;
    // 多個上界/下界（before:×older_than:、after:×newer_than:）取交集（較嚴者）而非後者覆蓋。
    else if (key === 'before') { const t = parseSearchDate(val); if (t) spec.before = tighterBefore(spec.before, t); }
    else if (key === 'after') { const t = parseSearchDate(val); if (t) spec.after = tighterAfter(spec.after, t); }
    else if (key === 'larger') { const b = parseSize(val); if (b) spec.larger = b; }
    else if (key === 'smaller') { const b = parseSize(val); if (b) spec.smaller = b; }
    // older_than:1y → 收信早於「現在−1y」(before)；newer_than:1w → 晚於「現在−1w」(after)
    else if (key === 'older_than') { const d = parseDuration(val); if (d) spec.before = tighterBefore(spec.before, Date.now() - d); }
    else if (key === 'newer_than') { const d = parseDuration(val); if (d) spec.after = tighterAfter(spec.after, Date.now() - d); }
    else if (key === 'filename' || key === 'file') spec.filename = val;
    else texts.push(tok);
  }
  spec.text = texts.join(' ');
  return spec;
}

export function searchParams(spec: SearchSpec): URLSearchParams {
  const p = new URLSearchParams();
  if (spec.text) p.set('q', spec.text);
  if (spec.from) p.set('from', spec.from);
  if (spec.to) p.set('to', spec.to);
  if (spec.cc) p.set('cc', spec.cc);
  if (spec.bcc) p.set('bcc', spec.bcc);
  if (spec.subject) p.set('subject', spec.subject);
  if (spec.hasAttachment) p.set('hasAttachment', '1');
  if (spec.isUnread) p.set('isUnread', '1');
  if (spec.isStarred) p.set('isStarred', '1');
  if (spec.label) p.set('labelName', spec.label);
  if (spec.before) p.set('before', String(spec.before));
  if (spec.after) p.set('after', String(spec.after));
  if (spec.larger) p.set('larger', String(spec.larger));
  if (spec.smaller) p.set('smaller', String(spec.smaller));
  if (spec.filename) p.set('filename', spec.filename);
  return p;
}
