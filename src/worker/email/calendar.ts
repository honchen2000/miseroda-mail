// iCalendar (RFC 5545) 會議邀請解析——只取顯示邀請卡所需的欄位，純函式（無 I/O）便於測試與擴充。
// 設計取捨：時區資料庫不在 worker 內，故 DTSTART/DTEND 僅對 UTC（尾碼 Z）與純日期做精確 epoch；
// 帶 TZID 的本地時間以「牆鐘時間 + 原樣字串」呈現（不臆測偏移），而「加入行事曆」一律下載原始 .ics，
// 由使用者的行事曆 App 依其 VTIMEZONE 處理，確保時間權威正確。

export interface CalendarEvent {
  /** REQUEST（邀請）/ CANCEL（取消）/ REPLY（回覆）/ PUBLISH… */
  method: string | null;
  summary: string | null;
  /** 顯示用起始時間字串（人類可讀，已依 UTC/日期格式化；TZID 則為牆鐘時間） */
  startText: string | null;
  endText: string | null;
  /** 精確 epoch（毫秒）——僅 UTC(Z)/純日期時提供，供「加入 Google 日曆」連結；TZID/floating 為 null */
  startMs: number | null;
  endMs: number | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  organizer: { name: string | null; email: string | null } | null;
  uid: string | null;
  /** RRULE 值（如 FREQ=WEEKLY;INTERVAL=1）；單次事件為 null。展開由 rrule.ts 負責。 */
  rrule: string | null;
  /** iTIP SEQUENCE（RFC 5545 §3.8.7.4）：同一 UID 的版本號，改期時遞增。
   *  parseIcs 一律填值（缺漏或不可解析 → 0）；由 app 自行組出的事件物件沒有這個概念，故為選填。
   *  F16.1 用它擋「重放一份舊的 .ics 把時間改回去」。 */
  sequence?: number;
}

/** 行折疊還原（RFC 5545 §3.1）：以 CRLF + 空白/Tab 接續的行併回上一行。 */
function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '') // 折疊續行：換行後緊接空白 → 併回
    .split('\n');
}

/** TEXT 值反跳脫（RFC 5545 §3.3.11）。 */
function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** 解析一行 `NAME[;PARAM=..]:VALUE` → { name, params, value } */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = head.split(';');
  const name = segs[0].toUpperCase();
  const params: Record<string, string> = {};
  for (const p of segs.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** 解析 DTSTART/DTEND 值 → { ms, text, allDay } */
function parseDate(value: string, params: Record<string, string>): { ms: number | null; text: string; allDay: boolean } {
  // 純日期：YYYYMMDD（VALUE=DATE 或長度 8）
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (params.VALUE === 'DATE' || dateOnly) {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (m) {
      const [, y, mo, d] = m;
      return { ms: Date.UTC(+y, +mo - 1, +d), text: `${y}/${mo}/${d}`, allDay: true };
    }
  }
  // 日期時間：YYYYMMDDTHHMMSS[Z]
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (dt) {
    const [, y, mo, d, h, mi, s, z] = dt;
    const text = `${y}/${mo}/${d} ${h}:${mi}`;
    if (z === 'Z') {
      return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), text, allDay: false };
    }
    // TZID / floating：不臆測偏移，呈現牆鐘時間（附 TZID 由呼叫端決定是否標註），epoch 留 null
    return { ms: null, text, allDay: false };
  }
  return { ms: null, text: value, allDay: false };
}

type EvMap = Record<string, { value: string; params: Record<string, string> }>;

/** 由單一 VEVENT 的欄位 map 組出 CalendarEvent（method 為行事曆層級，各事件共用）。 */
/** SEQUENCE 值正規化：非負整數才算數，其餘一律 0（值由寄件者控制，不可信）。 */
function seqOf(raw: string | undefined): number {
  const n = Number((raw ?? '').trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function buildEvent(ev: EvMap, method: string | null): CalendarEvent {
  const start = ev.DTSTART ? parseDate(ev.DTSTART.value, ev.DTSTART.params) : null;
  const end = ev.DTEND ? parseDate(ev.DTEND.value, ev.DTEND.params) : null;

  let organizer: CalendarEvent['organizer'] = null;
  if (ev.ORGANIZER) {
    const email = /mailto:(.+)/i.exec(ev.ORGANIZER.value)?.[1]?.trim() ?? null;
    organizer = { name: ev.ORGANIZER.params.CN ? unescapeText(ev.ORGANIZER.params.CN) : null, email };
  }

  return {
    method,
    summary: ev.SUMMARY ? unescapeText(ev.SUMMARY.value).trim() : null,
    startText: start?.text ?? null,
    endText: end?.text ?? null,
    startMs: start?.ms ?? null,
    endMs: end?.ms ?? null,
    allDay: start?.allDay ?? false,
    location: ev.LOCATION ? unescapeText(ev.LOCATION.value).trim() : null,
    description: ev.DESCRIPTION ? unescapeText(ev.DESCRIPTION.value).trim().slice(0, 2000) : null,
    organizer,
    uid: ev.UID ? ev.UID.value.trim() : null,
    rrule: ev.RRULE ? ev.RRULE.value.trim().slice(0, 500) || null : null,
    // 寄件者可寫任何字串進來 → 只收非負整數，其餘（缺漏／負數／NaN／超大值）一律視為 0。
    sequence: seqOf(ev.SEQUENCE?.value),
  };
}

/**
 * 解析 iCalendar 文字，取所有 VEVENT（F14.1 外部訂閱用）。非 calendar → 空陣列。
 * `cap` 上限保護（預設 500）避免惡意超大 feed 撐爆記憶體。
 */
export function parseIcsEvents(ics: string, cap = 500): CalendarEvent[] {
  if (!ics || !/BEGIN:VCALENDAR/i.test(ics)) return [];
  const lines = unfold(ics);
  let method: string | null = null;
  let inEvent = false;
  let ev: EvMap = {};
  const out: CalendarEvent[] = [];
  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'METHOD' && !inEvent) { method = line.value.trim().toUpperCase() || null; continue; }
    if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VEVENT') { inEvent = true; ev = {}; continue; }
    if (line.name === 'END' && line.value.toUpperCase() === 'VEVENT') {
      if (Object.keys(ev).length) out.push(buildEvent(ev, method));
      inEvent = false;
      if (out.length >= cap) break;
      continue;
    }
    if (inEvent && !(line.name in ev)) ev[line.name] = { value: line.value, params: line.params };
  }
  // 缺 END:VEVENT 的畸形 feed：保留寬容度，把未結束的最後一個事件也收下
  if (inEvent && Object.keys(ev).length && out.length < cap) out.push(buildEvent(ev, method));
  return out;
}

/**
 * 解析 iCalendar 文字，取第一個 VEVENT。非 calendar / 無 VEVENT → null。
 */
export function parseIcs(ics: string): CalendarEvent | null {
  return parseIcsEvents(ics, 1)[0] ?? null;
}

/* ============================ iCalendar 產生（RSVP REPLY） ============================ */

export type Partstat = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

/** UTC epoch(ms) → iCalendar 時間戳 YYYYMMDDTHHMMSSZ。 */
function formatUtcStamp(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-06-18T09:30:00.000Z
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** 參數值（如 CN）安全引號化：RFC 5545 §3.2 含 [,:;] 須以 DQUOTE 包覆，且引號字串內不可含 DQUOTE。 */
function quoteParam(v: string): string {
  return `"${v.replace(/[\r\n"]/g, ' ').trim()}"`;
}

/** TEXT 值跳脫（RFC 5545 §3.3.11）：先正規化換行，再依序跳脫 \ ; , 與換行。 */
function escapeText(v: string): string {
  return v
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/** RFC 5545 §3.1 內容行折疊：每行 ≤75 octets，續行以 CRLF + 單一空白接續（不截斷多位元組字元）。 */
function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  let out = '';
  let cur = '';
  let curBytes = 0;
  let first = true;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = first ? 75 : 74; // 續行開頭佔一個前導空白
    if (curBytes + b > limit) {
      out += (out ? '\r\n ' : '') + cur;
      first = false;
      cur = ch;
      curBytes = b;
    } else {
      cur += ch;
      curBytes += b;
    }
  }
  return out + (out ? '\r\n ' : '') + cur;
}

export interface ReplyInput {
  /** 原始邀請 .ics 全文（自 R2 取回，據以忠實回送 UID/ORGANIZER/DTSTART…，保留 TZID 等參數）。 */
  rawIcs: string;
  attendeeEmail: string;
  attendeeName?: string | null;
  partstat: Partstat;
  /** DTSTAMP 用的當下時間（UTC ms）。 */
  dtStampMs: number;
}

/**
 * 由收到的邀請產生 RFC 5546 METHOD:REPLY，供回覆出席狀態給組織者。
 * 忠實沿用原邀請第一個 VEVENT 的 UID/ORGANIZER/DTSTART/DTEND/SEQUENCE/SUMMARY 原行（保留參數），
 * 只新增本人 ATTENDEE 行（帶 PARTSTAT）與 DTSTAMP。無 UID 或無 ORGANIZER 的邀請無法回覆 → null。
 */
/**
 * 移除 content line 裡的控制字元（F19.2／2026-09-20 安全掃描 F9）。
 *
 * buildReply 會把原邀請的 UID/ORGANIZER/SEQUENCE/SUMMARY **整行原樣**重送進產生的 REPLY，
 * 而 unfold() 只正規化 CRLF 後以 LF 切分 → **單獨的 CR 會原封留在行內**。寄件者只要在 SUMMARY
 * 裡塞一個裸 CR 再接 `ATTENDEE;PARTSTAT=ACCEPTED:mailto:…`，受害者一按「接受」，就會從自己網域、
 * DKIM 簽名寄出一封 REPLY，在會以裸 CR 斷行的解析器上多出一位「已接受的與會者」。
 *
 * 這一行已經 unfold 過，合法的 CRLF 早就不在了——殘留的任何控制字元不是畸形就是要偽造 content line，
 * 一律剝掉。本專案的 calfeed.ts 對同一個向量已有 icsEscape，這裡是漏掉的另一半。
 */
function stripControlChars(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/[\u0000-\u001f\u007f]/g, '');
}

export function buildReply(input: ReplyInput): string | null {
  const { rawIcs, attendeeEmail, attendeeName, partstat, dtStampMs } = input;
  if (!rawIcs || !/BEGIN:VCALENDAR/i.test(rawIcs)) return null;

  let inEvent = false;
  const grab: Record<string, string> = {}; // 原行（verbatim），保留參數
  // 刻意不取 DTSTART/DTEND：帶 TZID 的時間需同附 VTIMEZONE 才合法（RFC 5545 §3.8.5.3），
  // 而 REPLY 並不需要時間（RFC 5546 §3.2.3 僅需 UID/ORGANIZER/ATTENDEE/DTSTAMP，組織者以 UID+ATTENDEE 比對）。
  // 只沿用無時區風險的欄位，避免產出不合法 .ics 被 Outlook/Exchange 拒收。
  const wanted = new Set(['UID', 'ORGANIZER', 'SEQUENCE', 'SUMMARY']);
  for (const raw of unfold(rawIcs)) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VEVENT') {
      inEvent = true;
      continue;
    }
    if (line.name === 'END' && line.value.toUpperCase() === 'VEVENT') break; // 只回覆第一個 VEVENT
    if (inEvent && wanted.has(line.name) && !(line.name in grab)) grab[line.name] = stripControlChars(raw);
  }
  if (!grab.UID || !grab.ORGANIZER) return null;

  const cn = attendeeName?.trim() ? `;CN=${quoteParam(attendeeName)}` : '';
  const attendee = `ATTENDEE${cn};PARTSTAT=${partstat}:mailto:${attendeeEmail}`;
  const out = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Miseroda Mail//RSVP//EN',
    'VERSION:2.0',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    grab.UID,
    grab.ORGANIZER,
    attendee,
    ...(grab.SUMMARY ? [grab.SUMMARY] : []),
    `DTSTAMP:${formatUtcStamp(dtStampMs)}`,
    grab.SEQUENCE ?? 'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return out.map(foldLine).join('\r\n') + '\r\n';
}

/* ============================ iCalendar 產生（自建會議邀請 REQUEST） ============================ */

export interface RequestInput {
  uid: string;
  organizerEmail: string;
  organizerName?: string | null;
  attendees: string[];
  summary: string;
  description?: string | null;
  location?: string | null;
  /** 起訖時間（UTC epoch ms）。輸出一律用 UTC（…Z），自帶不需 VTIMEZONE，跨客戶端最穩。 */
  startMs: number;
  endMs: number;
  dtStampMs: number;
  sequence?: number;
  /** RRULE 值（如 FREQ=WEEKLY）；單次事件省略。輸出於 VEVENT 內，收件方行事曆據此顯示為重複。 */
  rrule?: string | null;
}

/**
 * 產生 RFC 5546 METHOD:REQUEST（自建會議邀請）。時間以 UTC（…Z）輸出 → 不需 VTIMEZONE，互通性最佳。
 * 每位與會者帶 RSVP=TRUE，對方客戶端會提示回覆出席狀態（可用本系統的 RSVP 回覆閉環）。
 */
export function buildRequest(input: RequestInput): string {
  const { uid, organizerEmail, organizerName, attendees, summary, description, location, startMs, endMs, dtStampMs, sequence = 0 } = input;
  const cn = organizerName?.trim() ? `;CN=${quoteParam(organizerName)}` : '';
  const out = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Miseroda Mail//Invite//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${formatUtcStamp(dtStampMs)}`,
    `DTSTART:${formatUtcStamp(startMs)}`,
    `DTEND:${formatUtcStamp(endMs)}`,
    ...(input.rrule?.trim() ? [`RRULE:${input.rrule.trim()}`] : []),
    `SUMMARY:${escapeText(summary)}`,
    `ORGANIZER${cn}:mailto:${organizerEmail}`,
    ...attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
    ...(location?.trim() ? [`LOCATION:${escapeText(location)}`] : []),
    ...(description?.trim() ? [`DESCRIPTION:${escapeText(description)}`] : []),
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return out.map(foldLine).join('\r\n') + '\r\n';
}
