// F4.2a：搜尋運算子 larger:/smaller:/older_than:/newer_than:/filename:（純解析 + 後端過濾）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { parseSearch, parseSize, parseDuration, searchParams } from '../../src/app/lib/search';

describe('parseSize / parseDuration（純函式）', () => {
  it('size → bytes', () => {
    expect(parseSize('5m')).toBe(5 * 1024 * 1024);
    expect(parseSize('500k')).toBe(500 * 1024);
    expect(parseSize('2g')).toBe(2 * 1024 ** 3);
    expect(parseSize('1024')).toBe(1024);
    expect(parseSize('1.5m')).toBe(Math.round(1.5 * 1024 * 1024));
    expect(parseSize('abc')).toBeUndefined();
    expect(parseSize('0')).toBeUndefined();
  });
  it('duration → ms', () => {
    expect(parseDuration('1d')).toBe(86400000);
    expect(parseDuration('1w')).toBe(7 * 86400000);
    expect(parseDuration('1m')).toBe(30 * 86400000);
    expect(parseDuration('1y')).toBe(365 * 86400000);
    expect(parseDuration('xx')).toBeUndefined();
  });
});

describe('parseSearch 新運算子', () => {
  it('larger/smaller/filename + 剩餘文字；older_than/newer_than → before/after', () => {
    const s = parseSearch('larger:5m smaller:10m filename:報表 收據');
    expect(s.larger).toBe(5 * 1024 * 1024);
    expect(s.smaller).toBe(10 * 1024 * 1024);
    expect(s.filename).toBe('報表');
    expect(s.text).toBe('收據');
    const now = Date.now();
    const d = parseSearch('older_than:1y newer_than:1w');
    expect(d.before).toBeLessThanOrEqual(now);
    expect(d.before).toBeGreaterThan(now - 366 * 86400000);
    expect(d.after).toBeGreaterThan(now - 8 * 86400000);
    expect(d.after).toBeLessThanOrEqual(now);
    const p = searchParams(s);
    expect(p.get('larger')).toBe(String(5 * 1024 * 1024));
    expect(p.get('filename')).toBe('報表');
  });
  it('before: × older_than: 取交集（較嚴的上界）', () => {
    const t2020 = Date.parse('2020-01-01');
    // before:2020 比 older_than:1d 嚴格得多 → 取較早者 = 2020
    expect(parseSearch('before:2020-01-01 older_than:1d').before).toBe(t2020);
    expect(parseSearch('older_than:1d before:2020-01-01').before).toBe(t2020);
  });
});

describe('GET /messages 後端過濾（larger/smaller/filename）', () => {
  it('依大小/附件檔名過濾', async () => {
    const u = await seedUser(env, 'so@miseroda.com');
    const ins = async (id: string, size: number, fname: string | null) => {
      await env.DB.prepare(
        `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, size_bytes, has_attachments, is_read, received_at, created_at)
         VALUES (?, ?, ?, 'inbound', 'x@x.com', 'X', ?, '', 'inbox', ?, ?, 0, 1000, 1000)`,
      ).bind(id, u.userId, `t-${id}`, id, size, fname ? 1 : 0).run();
      if (fname)
        await env.DB.prepare(
          `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
           VALUES (?, ?, ?, ?, 'application/octet-stream', ?, 'attachment', ?, 0)`,
        ).bind(`a-${id}`, id, u.userId, fname, size, `k-${id}`).run();
    };
    await ins('big', 10 * 1024 * 1024, 'report.pdf');
    await ins('small', 1024, null);
    await ins('mid', 2 * 1024 * 1024, 'photo.jpg');

    const get = async (qs: string) => {
      const res = await worker.fetch(
        new Request(`https://mail.miseroda.com/api/v1/messages?${qs}`, {
          headers: { Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}` },
        }),
        env,
        createExecutionContext(),
      );
      return (await res.json()) as { items: { id: string }[] };
    };
    expect((await get('larger=5242880')).items.map((i) => i.id)).toEqual(['big']); // >5MB
    expect((await get('smaller=1048576')).items.map((i) => i.id)).toEqual(['small']); // <1MB
    expect((await get('filename=report')).items.map((i) => i.id)).toEqual(['big']); // report.pdf
  });
});
