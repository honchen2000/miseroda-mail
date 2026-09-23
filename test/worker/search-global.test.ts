// F2.6：全域跨域搜尋 GET /search 分組（信件 × 聯絡人 × 會議 × 跟進）。
// 註：信件 ≥3 字走 FTS（測試環境 raw INSERT 不會進 FTS 索引）→ 用 2 字查詢測信件 LIKE 路徑；
// 聯絡人/會議/跟進皆 LIKE，可直接驗。另測 ≥3 字 FTS 分支不噴錯 + 租戶隔離。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

type Seed = Awaited<ReturnType<typeof seedUser>>;
function get(path: string, u: Seed) {
  return worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1${path}`, {
      headers: { Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}` },
    }),
    env,
    createExecutionContext(),
  );
}

async function seedWang(u: Seed) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at)
     VALUES ('mw', ?, 'thrw', 'inbound', 'wang@corp.com', '王經理', '[]', '王經理報價單', '', 'inbox', ?, ?)`,
  ).bind(u.userId, now - 1000, now - 1000).run();
  await env.DB.prepare(
    `INSERT INTO calendar_events (id, user_id, uid, summary, start_ms, start_text, organizer, source, created_at)
     VALUES ('evw', ?, 'uidw', '與王經理開會', ?, '', 'wang@corp.com', 'received', ?)`,
  ).bind(u.userId, now + 86_400_000, now).run();
  await env.DB.prepare(
    `INSERT INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, ref_at, status, created_at)
     VALUES ('fuw', ?, 'mw', 'thrw', '王經理待回覆', ?, 0, ?, 'pending', ?)`,
  ).bind(u.userId, now + 86_400_000, now, now).run();
}

type SearchRes = { messages: unknown[]; contacts: { email: string }[]; events: { summary: string }[]; followUps: unknown[] };

describe('全域跨域搜尋（F2.6）', () => {
  it('一搜跨四域：信件(LIKE) + 聯絡人 + 會議 + 跟進', async () => {
    const u = await seedUser(env, 'me@miseroda.com');
    await seedWang(u);
    const res = await get('/search?q=王經', u); // 2 字 → 信件走 LIKE
    expect(res.status).toBe(200);
    const d = (await res.json()) as SearchRes;
    expect(d.messages.length).toBeGreaterThanOrEqual(1);
    expect(d.contacts.some((c) => c.email === 'wang@corp.com')).toBe(true);
    expect(d.events.some((e) => e.summary.includes('王經理'))).toBe(true);
    expect(d.followUps.length).toBe(1);
  });

  it('≥3 字走 FTS 分支不噴錯（聯絡人/會議/跟進仍 LIKE 命中）', async () => {
    const u = await seedUser(env, 'me2@miseroda.com');
    await seedWang(u);
    const res = await get('/search?q=王經理', u);
    expect(res.status).toBe(200);
    const d = (await res.json()) as SearchRes;
    expect(d.contacts.some((c) => c.email === 'wang@corp.com')).toBe(true);
    expect(d.events.length).toBeGreaterThanOrEqual(1);
    expect(d.followUps.length).toBe(1);
  });

  it('查詢 <2 字 → 全空', async () => {
    const u = await seedUser(env, 'me3@miseroda.com');
    await seedWang(u);
    const res = await get('/search?q=王', u);
    const d = (await res.json()) as SearchRes;
    expect(d.messages.length).toBe(0);
    expect(d.contacts.length).toBe(0);
    expect(d.events.length).toBe(0);
    expect(d.followUps.length).toBe(0);
  });

  it('租戶隔離：查不到別人的資料', async () => {
    const owner = await seedUser(env, 'owner@miseroda.com');
    await seedWang(owner);
    const other = await seedUser(env, 'other@miseroda.com');
    const res = await get('/search?q=王經', other);
    const d = (await res.json()) as SearchRes;
    expect(d.messages.length).toBe(0);
    expect(d.contacts.length).toBe(0);
    expect(d.events.length).toBe(0);
    expect(d.followUps.length).toBe(0);
  });
});
