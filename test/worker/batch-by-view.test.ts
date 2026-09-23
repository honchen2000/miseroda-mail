// F4.7：依虛擬夾批次處理（newsletter/receipt + read/archive + 可選寄件者）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

function post(u: Awaited<ReturnType<typeof seedUser>>, body: unknown) {
  return worker.fetch(
    new Request('https://mail.miseroda.com/api/v1/messages/batch-by-view', {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
        'X-CSRF-Token': u.cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    env,
    createExecutionContext(),
  );
}
const addMsg = (userId: string, id: string, o: { from?: string; subject?: string; folder?: string; unsub?: string | null } = {}) =>
  env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, is_read, list_unsubscribe, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', ?, 'X', ?, '', ?, 0, ?, 0, 0)`,
  ).bind(id, userId, `t-${id}`, o.from ?? 'x@x.com', o.subject ?? 's', o.folder ?? 'inbox', o.unsub ?? null).run();
const read = (id: string) => env.DB.prepare(`SELECT is_read FROM messages WHERE id=?`).bind(id).first<{ is_read: number }>();
const folderOf = (id: string) => env.DB.prepare(`SELECT folder FROM messages WHERE id=?`).bind(id).first<{ folder: string }>();

describe('batch-by-view（F4.7）', () => {
  it('newsletter 全部標已讀：只動電子報 lane，不碰一般信', async () => {
    const u = await seedUser(env, 'bv1@miseroda.com');
    await addMsg(u.userId, 'n1', { unsub: '<https://x/u>' });
    await addMsg(u.userId, 'n2', { unsub: '<https://x/u>' });
    await addMsg(u.userId, 'plain1', { unsub: null }); // 非電子報
    const res = await post(u, { view: 'newsletter', action: 'read' });
    expect(res.status).toBe(200);
    expect((await res.json<{ changes: number }>()).changes).toBe(2);
    expect((await read('n1'))?.is_read).toBe(1);
    expect((await read('n2'))?.is_read).toBe(1);
    expect((await read('plain1'))?.is_read).toBe(0); // 一般信不動
  });

  it('newsletter 全部封存：只封存仍在 inbox 的；已封存/垃圾不重動；寄件者過濾', async () => {
    const u = await seedUser(env, 'bv2@miseroda.com');
    await addMsg(u.userId, 'a', { unsub: '<u>', from: 'boss@x.com', folder: 'inbox' });
    await addMsg(u.userId, 'b', { unsub: '<u>', from: 'other@x.com', folder: 'inbox' });
    await addMsg(u.userId, 'c', { unsub: '<u>', from: 'boss@x.com', folder: 'archive' }); // 已封存
    // 只封存 boss 的 inbox 電子報 → 只 a
    const res = await post(u, { view: 'newsletter', action: 'archive', fromAddr: 'boss@x.com' });
    expect((await res.json<{ changes: number }>()).changes).toBe(1);
    expect((await folderOf('a'))?.folder).toBe('archive');
    expect((await folderOf('b'))?.folder).toBe('inbox'); // 非 boss
    expect((await folderOf('c'))?.folder).toBe('archive'); // 本就封存（folder='inbox' 過濾排除）
  });

  it('跨使用者隔離 + receipt lane', async () => {
    const u = await seedUser(env, 'bv3@miseroda.com');
    const other = await seedUser(env, 'bv4@miseroda.com');
    await addMsg(u.userId, 'r1', { subject: '您的訂單已確認 order confirm' });
    await addMsg(other.userId, 'other-r', { subject: '您的收據 receipt' });
    const res = await post(u, { view: 'receipt', action: 'read' });
    expect((await res.json<{ changes: number }>()).changes).toBe(1); // 只本人
    expect((await read('r1'))?.is_read).toBe(1);
    expect((await read('other-r'))?.is_read).toBe(0); // 別人不動
  });

  it('schema：未知 view / 未知 action → 400', async () => {
    const u = await seedUser(env, 'bv5@miseroda.com');
    expect((await post(u, { view: 'inbox', action: 'read' })).status).toBe(400);
    expect((await post(u, { view: 'newsletter', action: 'delete' })).status).toBe(400);
  });
});
