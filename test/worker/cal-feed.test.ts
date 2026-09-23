// F11.2：行事曆 ICS 訂閱 feed —— token 隔離/撤銷/重生失效/未知 404/ICS 內容含 RRULE 與跳脫。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { buildIcsFeed, icsEscape } from '../../src/worker/calfeed';

const BASE = 'https://mail.miseroda.com';

async function apiCall(
  path: string,
  cookies: { session: string; csrf: string },
  opts: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
    'X-CSRF-Token': cookies.csrf,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`${BASE}/api/v1${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    createExecutionContext(),
  );
}

const fetchFeed = (url: string) => worker.fetch(new Request(url), env, createExecutionContext());

async function seedEvent(userId: string, id: string, summary: string, rrule: string | null = null) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO calendar_events (id, user_id, uid, summary, start_ms, end_ms, start_text, all_day, floating, location, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 0, 0, '會議室; A,B', 'created', ?)`,
  ).bind(id, userId, `uid-${id}`, summary, now + 86400_000, now + 90000_000, now).run();
  if (rrule) await env.DB.prepare(`UPDATE calendar_events SET rrule = ? WHERE id = ?`).bind(rrule, id).run();
}

describe('F11.2 行事曆 ICS 訂閱 feed', () => {
  it('產生 → 訂到自己的事件（含 RRULE 原樣、TEXT 跳脫）；只見自己的、不見他人', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    await seedEvent(hon.userId, 'ev1', '家庭聚餐, 每週');
    await env.DB.prepare(`UPDATE calendar_events SET rrule = 'FREQ=WEEKLY;BYDAY=FR' WHERE id = 'ev1'`).run();
    await seedEvent(kai.userId, 'ev2', '別人的私事');

    const { url } = (await (await apiCall('/calendar/feed', hon.cookies, { body: {} })).json()) as { url: string };
    expect(url).toMatch(/\/cal\/[A-Za-z0-9_-]{20,}\.ics$/);

    const res = await fetchFeed(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/calendar');
    const ics = await res.text();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('SUMMARY:家庭聚餐\\, 每週'); // 逗號跳脫
    expect(ics).toContain('LOCATION:會議室\\; A\\,B');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=FR');
    expect(ics).not.toContain('別人的私事'); // 隔離
  });

  it('重生使舊網址失效；撤銷後 404；未知 token 404', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const { url: oldUrl } = (await (await apiCall('/calendar/feed', hon.cookies, { body: {} })).json()) as { url: string };
    const { url: newUrl } = (await (await apiCall('/calendar/feed', hon.cookies, { body: {} })).json()) as { url: string };
    expect((await fetchFeed(oldUrl)).status).toBe(404); // 舊 token 立即失效
    expect((await fetchFeed(newUrl)).status).toBe(200);

    await apiCall('/calendar/feed', hon.cookies, { method: 'DELETE' });
    expect((await fetchFeed(newUrl)).status).toBe(404);
    expect((await fetchFeed(`${BASE}/cal/${'0'.repeat(64)}.ics`)).status).toBe(404);
    expect((await fetchFeed(`${BASE}/cal/短token.ics`)).status).toBe(404); // 格式守門
  });

  it('buildIcsFeed 純函式：全天事件 DTEND 排他隔日；icsEscape 覆蓋反斜線/換行', () => {
    const ics = buildIcsFeed('t', [{ id: 'a', summary: 's', start_ms: Date.UTC(2026, 6, 10), end_ms: null, all_day: 1, location: '', rrule: null }], Date.UTC(2026, 6, 1));
    expect(ics).toContain('DTSTART;VALUE=DATE:20260710');
    expect(ics).toContain('DTEND;VALUE=DATE:20260711');
    expect(icsEscape('a\\b\nc')).toBe('a\\\\b\\nc');
  });

  it('content-line 注入：夾帶裸 CR 的 RRULE 整行不輸出、SUMMARY 的裸 CR 跳脫；合法 RRULE 原樣保留', () => {
    const ev = (rrule: string | null, summary = 's') => ({ id: 'a', summary, start_ms: Date.UTC(2026, 6, 10), end_ms: null, all_day: 0, location: '', rrule });
    // 合法規則（含本專案 /calendar/invite 產的四種、BYDAY/COUNT/UNTIL、寬鬆空白）一律原樣輸出
    for (const ok of ['FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=FR', 'FREQ=MONTHLY;INTERVAL=2;COUNT=10', 'FREQ=YEARLY;UNTIL=20301231T235959Z', 'FREQ=WEEKLY; BYDAY=MO,TU', 'FREQ=MONTHLY;BYDAY=-1SU;BYSETPOS=+1']) {
      expect(buildIcsFeed('t', [ev(ok)], 0)).toContain(`RRULE:${ok}\r\n`);
    }
    // 注入：RRULE 值夾帶裸 CR + 偽造行 → 該 RRULE 行整行不輸出，事件本身照常
    const inj = buildIcsFeed('t', [ev('FREQ=DAILY\rBEGIN:VALARM\rACTION:DISPLAY\rTRIGGER:PT0S\rEND:VALARM')], 0);
    expect(inj).not.toContain('RRULE:');
    expect(inj).not.toContain('BEGIN:VALARM');
    expect(inj).toContain('BEGIN:VEVENT');
    // TEXT 欄位的裸 CR / CRLF 一律跳脫成 \n，長不出新的 content line
    expect(buildIcsFeed('t', [ev(null, '午餐\rBEGIN:VALARM')], 0)).toContain('SUMMARY:午餐\\nBEGIN:VALARM\r\n');
    expect(icsEscape('a\rb')).toBe('a\\nb');
    expect(icsEscape('a\r\nb')).toBe('a\\nb');
  });
});
