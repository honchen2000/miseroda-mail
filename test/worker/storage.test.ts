// F4.6a：使用者端儲存用量（formatBytes 純函式 + GET /storage 總量/排序/隔離）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { formatBytes } from '../../src/app/lib/format';

function call(u: Awaited<ReturnType<typeof seedUser>>, path: string) {
  return worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1${path}`, {
      headers: { Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}` },
    }),
    env,
    createExecutionContext(),
  );
}
const addMsg = (userId: string, id: string, size: number) =>
  env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, size_bytes, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', 'x@x.com', 'X', ?, '', 'inbox', ?, 0, 0)`,
  ).bind(id, userId, `t-${id}`, id, size).run();

describe('formatBytes（純函式）', () => {
  it('B / KB / MB / GB；0/負→0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1048576)).toBe('5.0 MB');
    expect(formatBytes(3 * 1073741824)).toBe('3.00 GB');
  });
});

describe('GET /storage（F4.6a）', () => {
  it('總量 = 信件+附件；largest 由大到小；跨使用者隔離', async () => {
    const u = await seedUser(env, 'st1@miseroda.com');
    const other = await seedUser(env, 'st2@miseroda.com');
    await addMsg(u.userId, 'big', 10 * 1048576);
    await addMsg(u.userId, 'small', 1024);
    await env.DB.prepare(
      `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
       VALUES ('a1', 'big', ?, 'f.pdf', 'application/pdf', ?, 'attachment', 'k1', 0)`,
    ).bind(u.userId, 2 * 1048576).run();
    await addMsg(other.userId, 'others', 99 * 1048576); // 別人的，不該計入

    const data = await (await call(u, '/storage')).json<{
      totalBytes: number; messageBytes: number; attachmentBytes: number; messageCount: number;
      largest: { id: string; sizeBytes: number }[];
    }>();
    expect(data.messageBytes).toBe(10 * 1048576 + 1024);
    expect(data.attachmentBytes).toBe(2 * 1048576);
    expect(data.totalBytes).toBe(10 * 1048576 + 1024 + 2 * 1048576);
    expect(data.messageCount).toBe(2);
    expect(data.largest.map((m) => m.id)).toEqual(['big', 'small']); // 由大到小
    expect(data.largest.some((m) => m.id === 'others')).toBe(false); // 隔離
  });
});
