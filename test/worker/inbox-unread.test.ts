// F1.3：inboxUnreadCount —— Web Push 帶給 SW 設 OS 角標的未讀數。
// 須與 /counts 一致：只算收件匣未讀、排除已讀/其他資料夾/未到期 snoozed、且按使用者隔離。
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { seedUser } from './helpers/fixtures';
import { inboxUnreadCount } from '../../src/worker/lib/notify';

let mid = 0;
async function insert(userId: string, args: { folder?: string; read?: boolean; snoozedUntil?: number | null } = {}) {
  mid += 1;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, subject, snippet, folder, is_read, snoozed_until, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', 'a@x.com', 's', '', ?, ?, ?, ?, ?)`,
  )
    .bind(`m${mid}`, userId, `t${mid}`, args.folder ?? 'inbox', args.read ? 1 : 0, args.snoozedUntil ?? null, now, now)
    .run();
}

describe('inboxUnreadCount（F1.3 OS 角標未讀數）', () => {
  it('只算收件匣未讀：排除已讀 / 其他資料夾 / 未到期 snoozed', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await insert(u.userId); // inbox 未讀 ✓
    await insert(u.userId); // inbox 未讀 ✓
    await insert(u.userId, { read: true }); // inbox 已讀 ✗
    await insert(u.userId, { folder: 'archive' }); // 其他資料夾 ✗
    await insert(u.userId, { snoozedUntil: Date.now() + 86400_000 }); // snoozed 未到期 ✗
    await insert(u.userId, { snoozedUntil: Date.now() - 1000 }); // snoozed 已過期 → 算 ✓
    expect(await inboxUnreadCount(env, u.userId)).toBe(3);
  });

  it('按使用者隔離', async () => {
    const a = await seedUser(env, 'a@miseroda.com');
    const b = await seedUser(env, 'b@miseroda.com');
    await insert(a.userId);
    await insert(b.userId);
    await insert(b.userId);
    expect(await inboxUnreadCount(env, a.userId)).toBe(1);
    expect(await inboxUnreadCount(env, b.userId)).toBe(2);
  });
});
