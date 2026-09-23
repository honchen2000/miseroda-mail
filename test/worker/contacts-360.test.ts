// F2.5：聯絡人 360 純讀聚合端點 + /contacts/suggest 多回 lastUsed。
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

describe('聯絡人 360 聚合（F2.5）', () => {
  it('GET /contacts/profile/:email 聚合最近往來/未來會議/待回覆/信任卡', async () => {
    const u = await seedUser(env, 'me@miseroda.com');
    const peer = 'peer@example.com';
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at, auth_verdict)
       VALUES ('m_in', ?, 'thr1', 'inbound', ?, 'Peer', '["me@miseroda.com"]', '報價詢問', '', 'inbox', ?, ?, '{"spf":"pass","dkim":"pass","dmarc":"pass"}')`,
    ).bind(u.userId, peer, now - 1000, now - 1000).run();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at)
       VALUES ('m_out', ?, 'thr1', 'outbound', 'me@miseroda.com', '我', ?, '回覆報價', '', 'sent', ?, ?)`,
    ).bind(u.userId, JSON.stringify([peer]), now - 500, now - 500).run();
    await env.DB.prepare(
      `INSERT INTO calendar_events (id, user_id, uid, summary, start_ms, start_text, organizer, source, created_at)
       VALUES ('ev1', ?, 'uid1', '專案會議', ?, '', ?, 'received', ?)`,
    ).bind(u.userId, now + 3 * 86_400_000, peer, now).run();
    await env.DB.prepare(
      `INSERT INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, ref_at, status, created_at)
       VALUES ('fu1', ?, 'm_in', 'thr1', '報價詢問', ?, 0, ?, 'pending', ?)`,
    ).bind(u.userId, now + 86_400_000, now, now).run();

    const res = await get(`/contacts/profile/${encodeURIComponent(peer)}`, u);
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      email: string; totalMessages: number; messages: unknown[];
      events: { summary: string }[]; followUps: unknown[]; authVerdict: unknown;
    };
    expect(d.email).toBe(peer);
    expect(d.totalMessages).toBe(2);
    expect(d.messages.length).toBe(2);
    expect(d.events.length).toBe(1);
    expect(d.events[0].summary).toBe('專案會議');
    expect(d.followUps.length).toBe(1);
    expect(d.authVerdict).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  it('user/email scoped：不混入他人往來', async () => {
    const u = await seedUser(env, 'me2@miseroda.com');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at)
       VALUES ('mx', ?, 'thrx', 'inbound', 'other@example.com', 'Other', '[]', '別人', '', 'inbox', ?, ?)`,
    ).bind(u.userId, now, now).run();
    const res = await get(`/contacts/profile/${encodeURIComponent('peer@example.com')}`, u);
    const d = (await res.json()) as { totalMessages: number; messages: unknown[]; authVerdict: unknown };
    expect(d.totalMessages).toBe(0);
    expect(d.messages.length).toBe(0);
    expect(d.authVerdict).toBeNull();
  });

  it('/contacts/suggest 多回 lastUsed（F2.5 形狀）', async () => {
    const u = await seedUser(env, 'me3@miseroda.com');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at)
       VALUES ('ms', ?, 'thrs', 'outbound', 'me3@miseroda.com', '我', ?, 'hi', '', 'sent', ?, ?)`,
    ).bind(u.userId, JSON.stringify(['friend@example.com']), now, now).run();
    const res = await get('/contacts/suggest?q=friend', u);
    const d = (await res.json()) as { suggestions: { addr: string; lastUsed: number }[] };
    expect(Array.isArray(d.suggestions)).toBe(true);
    expect(d.suggestions[0]).toMatchObject({ addr: 'friend@example.com' });
    expect(typeof d.suggestions[0].lastUsed).toBe('number');
  });
});
