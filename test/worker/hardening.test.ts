// M6 硬化：安全標頭、限流、FTS 重建
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const ORIGIN = 'https://mail.miseroda.com';

describe('hardening', () => {
  it('security headers on API responses', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/v1/health`), env, createExecutionContext());
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    // JSON 不需要 CSP
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    await res.json();
  });

  it('rate limit kicks in on auth endpoints', async () => {
    const ip = '203.0.113.9';
    let limited = 0;
    for (let i = 0; i < 18; i++) {
      const res = await worker.fetch(
        new Request(`${ORIGIN}/api/v1/auth/invite/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
          body: JSON.stringify({ code: 'XXXX-XXXX-XXXX' }),
        }),
        env,
        createExecutionContext(),
      );
      if (res.status === 429) limited += 1;
      await res.json();
    }
    expect(limited).toBeGreaterThanOrEqual(3); // 15/分鐘上限後擋下

    // 不同 IP 不受影響
    const other = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/auth/invite/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify({ code: 'XXXX-XXXX-XXXX' }),
      }),
      env,
      createExecutionContext(),
    );
    expect(other.status).toBe(404);
    await other.json();
  });

  it('FTS rebuild reindexes from main DB', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const envQuiet = { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
    await worker.email(
      mockEmailMessage(plainEmail({ subject: '重建測試信', body: '極光下的企鵝排隊寄信。' })).message,
      envQuiet,
      createExecutionContext(),
    );
    // 尚未跑 ingest consumer → FTS 還沒有這封
    const before = await env.DB_FTS.prepare(`SELECT COUNT(*) AS n FROM msg_map`).first<{ n: number }>();
    expect(before!.n).toBe(0);

    const call = (body: unknown) =>
      worker.fetch(
        new Request(`${ORIGIN}/api/v1/admin/fts/rebuild`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `__Host-session=${encodeURIComponent(hon.cookies.session)}; __Host-csrf=${encodeURIComponent(hon.cookies.csrf)}`,
            'X-CSRF-Token': hon.cookies.csrf,
          },
          body: JSON.stringify(body),
        }),
        env,
        createExecutionContext(),
      );

    let cursor: string | null = null;
    let total = 0;
    do {
      const res = await call({ cursor });
      expect(res.status).toBe(200);
      const data = await res.json<{ processed: number; nextCursor: string | null }>();
      total += data.processed;
      cursor = data.nextCursor;
    } while (cursor);
    expect(total).toBeGreaterThanOrEqual(1);

    const hit = await env.DB_FTS.prepare(
      `SELECT m.message_id FROM messages_fts f JOIN msg_map m ON m.fts_rowid = f.rowid
       WHERE messages_fts MATCH ? AND m.user_id = ?`,
    )
      .bind('重建測試', hon.userId)
      .all();
    expect(hit.results).toHaveLength(1);
  });
});
