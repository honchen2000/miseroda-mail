// F4.6b：分享連結清單 / 一鍵延長 / 到期前提醒 cron。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { sweep } from '../../src/worker/jobs/sweep';

const DAY = 86_400_000;
function call(u: Awaited<ReturnType<typeof seedUser>>, path: string, opts: { method?: string } = {}) {
  return worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1${path}`, {
      method: opts.method ?? 'GET',
      headers: { Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`, 'X-CSRF-Token': u.cookies.csrf },
    }),
    env,
    createExecutionContext(),
  );
}
const addShare = (userId: string, id: string, expiresAt: number, reminded = 0, createdAt = Date.now()) =>
  env.DB.prepare(
    `INSERT INTO shared_files (id, token, user_id, filename, mime_type, size_bytes, r2_key, download_count, expires_at, expiry_reminded, created_at)
     VALUES (?, ?, ?, 'f.pdf', 'application/pdf', 1000, ?, 0, ?, ?, ?)`,
  ).bind(id, `tok-${id}`, userId, `share/${id}`, expiresAt, reminded, createdAt).run();

describe('分享連結清單 + 延長（F4.6b）', () => {
  it('GET /share 只列本人；POST extend 延一個 TTL+重置提醒；跨人 404；過期 410', async () => {
    const u = await seedUser(env, 'sh1@miseroda.com');
    const other = await seedUser(env, 'sh2@miseroda.com');
    const exp = Date.now() + 2 * DAY;
    await addShare(u.userId, 'mine', exp, 1);
    await addShare(other.userId, 'theirs', exp);
    const list = await (await call(u, '/share')).json<{ shares: { id: string; url: string }[] }>();
    expect(list.shares.map((s) => s.id)).toEqual(['mine']); // 隔離
    expect(list.shares[0].url).toContain('/dl/tok-mine');

    const ext = await (await call(u, '/share/mine/extend', { method: 'POST' })).json<{ ok: boolean; expiresAt: number }>();
    expect(ext.ok).toBe(true);
    expect(ext.expiresAt).toBeGreaterThan(exp); // 延長了
    const row = await env.DB.prepare(`SELECT expiry_reminded FROM shared_files WHERE id='mine'`).first<{ expiry_reminded: number }>();
    expect(row?.expiry_reminded).toBe(0); // 延長後重置提醒

    expect((await call(other, '/share/mine/extend', { method: 'POST' })).status).toBe(404); // 跨人
    await addShare(u.userId, 'dead', Date.now() - DAY); // 已過期
    expect((await call(u, '/share/dead/extend', { method: 'POST' })).status).toBe(410);
    // 總壽命上限：到期日已＝建立起 90 天（已達上限）→ 延長被擋 409 max_lifetime（防無限延長）[Codex]
    const c80 = Date.now() - 80 * DAY;
    await addShare(u.userId, 'oldlink', c80 + 90 * DAY, 0, c80); // expires_at == created+90d
    expect((await call(u, '/share/oldlink/extend', { method: 'POST' })).status).toBe(409);
  });

  it('sweep：48h 內到期且未提醒 → 標記 expiry_reminded=1；遠期不動', async () => {
    const u = await seedUser(env, 'sh3@miseroda.com');
    await addShare(u.userId, 'soon', Date.now() + 24 * 3600 * 1000, 0); // 24h 內
    await addShare(u.userId, 'later', Date.now() + 5 * DAY, 0); // 5 天後
    await sweep(env);
    expect((await env.DB.prepare(`SELECT expiry_reminded FROM shared_files WHERE id='soon'`).first<{ expiry_reminded: number }>())?.expiry_reminded).toBe(1);
    expect((await env.DB.prepare(`SELECT expiry_reminded FROM shared_files WHERE id='later'`).first<{ expiry_reminded: number }>())?.expiry_reminded).toBe(0);
  });
});
