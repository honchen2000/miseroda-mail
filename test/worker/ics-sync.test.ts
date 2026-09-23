// F14.1：外部 ICS 訂閱——多事件解析 + 同步/SSRF/快取 + /calendar/events 併入。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { parseIcsEvents } from '../../src/worker/email/calendar';
import { readSubs, runIcsSync, icsCacheKey, type IcsCache } from '../../src/worker/jobs/icsSync';
import { seedUser } from './helpers/fixtures';

const SAMPLE = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:a@x\r
SUMMARY:第一場\r
DTSTART:20260710T020000Z\r
DTEND:20260710T030000Z\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:b@x\r
SUMMARY:第二場\r
DTSTART:20260711T020000Z\r
END:VEVENT\r
END:VCALENDAR`;

describe('F14.1 parseIcsEvents（多事件）', () => {
  it('取所有 VEVENT；parseIcs 相容仍取第一個', () => {
    const evs = parseIcsEvents(SAMPLE);
    expect(evs).toHaveLength(2);
    expect(evs[0].summary).toBe('第一場');
    expect(evs[1].summary).toBe('第二場');
    expect(evs[0].startMs).toBe(Date.UTC(2026, 6, 10, 2, 0, 0));
    expect(parseIcsEvents('not a calendar')).toEqual([]);
  });
});

describe('F14.1 readSubs（容錯 + SSRF 過濾）', () => {
  it('過濾非 https/內網/超量，label 截斷', () => {
    const raw = JSON.stringify({
      icsSubscriptions: [
        { url: 'https://cal.example.com/a.ics', label: '家庭' },
        { url: 'http://cal.example.com/b.ics' }, // 非 https → 丟
        { url: 'https://localhost/c.ics' }, // 內網 → 丟
        { url: 'https://cal.example.com/d.ics', label: 'x'.repeat(200) },
        { url: 'https://cal.example.com/e.ics' },
        { url: 'https://cal.example.com/f.ics' },
        { url: 'https://cal.example.com/g.ics' }, // 第 6 條（有效者超過 5）→ slice 掉
      ],
    });
    const subs = readSubs(raw);
    expect(subs.length).toBeLessThanOrEqual(5);
    expect(subs.every((s) => s.url.startsWith('https://cal.example.com'))).toBe(true);
    expect(subs.find((s) => s.label.length > 60)).toBeUndefined();
    expect(readSubs('garbage')).toEqual([]);
    expect(readSubs(null)).toEqual([]);
  });
});

describe('F14.1 fetchIcs SSRF redirect 防護', () => {
  it('302 導向內網 → 擋下（每一跳重驗）；302 導向公開 → 跟隨', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    await env.DB.prepare(`INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', ?, ?)`)
      .bind(hon.userId, JSON.stringify({ icsSubscriptions: [
        { url: 'https://evil.example.com/redirect.ics', label: '惡意' },
        { url: 'https://good.example.com/hop.ics', label: '公開跳轉' },
      ] }), Date.now())
      .run();
    const fakeFetch = (async (url: string) => {
      const u = String(url);
      if (u === 'https://evil.example.com/redirect.ics') {
        return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } });
      }
      if (u === 'https://good.example.com/hop.ics') {
        return new Response(null, { status: 302, headers: { location: 'https://cal.example.com/final.ics' } });
      }
      if (u === 'https://cal.example.com/final.ics') return new Response(SAMPLE, { status: 200 });
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;

    await runIcsSync(env, fakeFetch);
    const cache = JSON.parse((await env.KV.get(icsCacheKey(hon.userId)))!) as IcsCache;
    expect(cache.feeds.find((f) => f.label === '惡意')?.status).toBe('error'); // 內網跳轉被擋
    expect(cache.feeds.find((f) => f.label === '公開跳轉')?.status).toBe('ok'); // 公開跳轉照跟
    expect(cache.feeds.find((f) => f.label === '公開跳轉')?.count).toBe(2);
  });
});

describe('F14.1 runIcsSync + /calendar/events 併入', () => {
  it('fetch→解析→KV 快取；壞 feed 標 error 不擋好 feed；行事曆端點顯示 external', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', ?, ?)`,
    )
      .bind(hon.userId, JSON.stringify({ icsSubscriptions: [
        { url: 'https://cal.example.com/good.ics', label: '球隊' },
        { url: 'https://cal.example.com/bad.ics', label: '壞的' },
      ] }), Date.now())
      .run();

    const fakeFetch = (async (url: string) => {
      if (String(url).includes('good')) {
        return new Response(SAMPLE, { status: 200 });
      }
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;

    const res = await runIcsSync(env, fakeFetch);
    expect(res.users).toBe(1);
    expect(res.feeds).toBe(1); // 只有 good 成功

    const cache = JSON.parse((await env.KV.get(icsCacheKey(hon.userId)))!) as IcsCache;
    expect(cache.events).toHaveLength(2);
    expect(cache.feeds.find((f) => f.label === '壞的')?.status).toBe('error');
    expect(cache.feeds.find((f) => f.label === '球隊')?.status).toBe('ok');

    // /calendar/events 併入（source: external）
    const from = Date.UTC(2026, 6, 1);
    const to = Date.UTC(2026, 6, 31);
    const evRes = await worker.fetch(
      new Request(`https://mail.miseroda.com/api/v1/calendar/events?from=${from}&to=${to}`, {
        headers: {
          Cookie: `__Host-session=${encodeURIComponent(hon.cookies.session)}; __Host-csrf=${encodeURIComponent(hon.cookies.csrf)}`,
          'X-CSRF-Token': hon.cookies.csrf,
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(evRes.status).toBe(200);
    const data = await evRes.json<{ events: { summary: string; source: string }[] }>();
    const ext = data.events.filter((e) => e.source === 'external');
    expect(ext.length).toBe(2);
    expect(ext.map((e) => e.summary).sort()).toEqual(['第一場', '第二場']);
  });
});
