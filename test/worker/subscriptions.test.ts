// F9.3：訂閱管理儀表板 —— GET /subscriptions 聚合正確性 + batch-by-view trash 動作。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

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
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    createExecutionContext(),
  );
}

let seq = 0;
async function insertNews(userId: string, args: { from?: string; name?: string; ago?: number; unread?: boolean; folder?: string; listUnsub?: boolean; starred?: boolean } = {}) {
  seq += 1;
  const id = `sub${seq}`;
  const at = Date.now() - (args.ago ?? 0);
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, is_read,
                           is_starred, list_unsubscribe, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', ?, ?, 's', '', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, `t-${id}`, args.from ?? 'news@letters.com', args.name ?? 'Letters',
      args.folder ?? 'inbox', args.unread ? 0 : 1, args.starred ? 1 : 0,
      args.listUnsub === false ? null : '<https://x.com/u>', at, at)
    .run();
  return id;
}

describe('F9.3 訂閱管理', () => {
  it('聚合：by 寄件者計 近30天/未讀/總數/最後一封/最新 id；排除 trash/spam 與非電子報；使用者隔離', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const DAY = 86400_000;
    await insertNews(hon.userId, { ago: 40 * DAY }); // 舊的（不算近30天）
    await insertNews(hon.userId, { ago: 5 * DAY, unread: true });
    const latest = await insertNews(hon.userId, { ago: 1 * DAY });
    await insertNews(hon.userId, { from: 'promo@shop.com', name: 'Shop', ago: 2 * DAY });
    await insertNews(hon.userId, { ago: 3 * DAY, folder: 'trash' }); // trash 不算
    await insertNews(hon.userId, { ago: 3 * DAY, listUnsub: false }); // 非電子報不算
    await insertNews(kai.userId, { ago: 1 * DAY }); // 他人不外洩

    const res = await apiCall('/subscriptions', hon.cookies);
    expect(res.status).toBe(200);
    const { subscriptions } = (await res.json()) as { subscriptions: { addr: string; total: number; last30: number; unread: number; latestId: string }[] };
    expect(subscriptions.length).toBe(2);
    const letters = subscriptions.find((s) => s.addr === 'news@letters.com')!;
    expect(letters.total).toBe(3);
    expect(letters.last30).toBe(2);
    expect(letters.unread).toBe(1);
    expect(letters.latestId).toBe(latest);
    expect(subscriptions[0].addr).toBe('news@letters.com'); // 最後一封最近者排前
  });

  it('batch-by-view trash：只動該寄件者的電子報、星標不動、可復原（folder=trash）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const a = await insertNews(hon.userId, {});
    const starred = await insertNews(hon.userId, { starred: true });
    const other = await insertNews(hon.userId, { from: 'promo@shop.com' });
    const res = await apiCall('/messages/batch-by-view', hon.cookies, {
      body: { view: 'newsletter', action: 'trash', fromAddr: 'news@letters.com' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changes: number }).changes).toBe(1);
    const folderOf = async (id: string) =>
      (await env.DB.prepare(`SELECT folder FROM messages WHERE id = ?`).bind(id).first<{ folder: string }>())!.folder;
    expect(await folderOf(a)).toBe('trash');
    expect(await folderOf(starred)).toBe('inbox');
    expect(await folderOf(other)).toBe('inbox');
  });
});
