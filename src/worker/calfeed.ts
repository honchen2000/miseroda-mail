// F11.2：行事曆 ICS 訂閱 feed（對外唯讀端點）。
// 安全邊界：token 高熵（randomToken）、DB 只存 SHA-256、未知 token 一律 404（不可枚舉）、
// IP 限流 60/分（防掃描）、輸出唯讀 text/calendar、絕不含他人資料（token→單一 user）。
import { sha256Hex } from './lib/crypto';
import { checkRateLimit } from './lib/ratelimit';

interface FeedEventRow {
  id: string;
  summary: string;
  start_ms: number;
  end_ms: number | null;
  all_day: number;
  location: string;
  rrule: string | null;
}

/**
 * iCalendar TEXT 跳脫（RFC 5545：反斜線、分號、逗號、換行）。
 * 換行三種寫法都要吃：CRLF、LF、**單獨的 CR**——來信 .ics 的解析器只把 CRLF/LF 當行尾，
 * 裸 \r 會原封不動存進 summary/location，若不跳脫，把裸 \r 當行尾的訂閱端就會讀到偽造的 content line。
 */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|[\r\n]/g, '\\n');
}

/**
 * RRULE 值（RFC 5545 RECUR）不是 TEXT，不能跳脫，只能白名單守門。
 * 合法 RECUR 值只由英數與 `=;,:+-/` 組成（再寬容空白，因為本專案 parseRrule 對各分段做 trim，
 * 對 `FREQ=WEEKLY; BYDAY=MO` 這種寬鬆寫法本來就吃得下）——白名單是合法文法的**超集**，
 * 不會擋掉任何 RFC 合法的重複規則；而換行/控制字元在合法值裡不可能出現，出現即是要偽造 content line。
 */
const RRULE_SAFE = /^[A-Za-z0-9=;,:+\/ -]+$/;

function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 事件列 → VCALENDAR 字串（純函式，可測）。RRULE 通過白名單後原樣輸出，交由訂閱端展開。 */
export function buildIcsFeed(calName: string, events: FeedEventRow[], now = Date.now()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Miseroda Mail//Calendar Feed//ZH',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsEscape(calName)}`,
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${icsEscape(e.id)}@miseroda.com`, `DTSTAMP:${icsUtc(now)}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.start_ms)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate((e.end_ms ?? e.start_ms) + 86400_000)}`); // DATE 的 DTEND 為排他隔日
    } else {
      lines.push(`DTSTART:${icsUtc(e.start_ms)}`);
      if (e.end_ms) lines.push(`DTEND:${icsUtc(e.end_ms)}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.summary || '(無標題)')}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    // 不合白名單（含夾帶換行的注入）→ 整行不輸出：事件仍以單次事件出現，絕不讓值長出新的 content line
    if (e.rrule) {
      const rule = e.rrule.replace(/^RRULE:/i, '');
      if (RRULE_SAFE.test(rule)) lines.push(`RRULE:${rule}`);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** 對外唯讀 feed：/cal/<token>.ics。 */
export async function serveCalFeed(rawToken: string, env: Env, ip: string): Promise<Response> {
  if (!(await checkRateLimit(env, `calfeed:${ip}`, 60, 60))) {
    return new Response('rate limited', { status: 429 });
  }
  const token = rawToken.replace(/\.ics$/i, '');
  // 格式守門只是省一次 DB 查詢的粗篩；真正的驗證是下方 hash 查表（randomToken 為 base64url）
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return new Response('not found', { status: 404 });
  const row = await env.DB.prepare(
    `SELECT t.user_id, u.email FROM cal_feed_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND u.status = 'active'`,
  )
    .bind(await sha256Hex(token))
    .first<{ user_id: string; email: string }>();
  if (!row) return new Response('not found', { status: 404 });

  // 近 90 天到未來一年的單次事件 + 全部重複事件（RRULE 原樣，訂閱端自行展開）
  const from = Date.now() - 90 * 86400_000;
  const to = Date.now() + 366 * 86400_000;
  const events = await env.DB.prepare(
    `SELECT id, summary, start_ms, end_ms, all_day, location, rrule FROM calendar_events
     WHERE user_id = ? AND ((rrule IS NULL AND start_ms >= ? AND start_ms < ?) OR rrule IS NOT NULL)
     ORDER BY start_ms ASC LIMIT 500`,
  )
    .bind(row.user_id, from, to)
    .all<FeedEventRow>();

  return new Response(buildIcsFeed(`${row.email} 的行事曆`, events.results), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
