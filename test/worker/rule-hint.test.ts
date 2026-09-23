// F14.3：規則建議 nudge——GET /messages/:id/rule-hint 門檻/抑制/隔離。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';
let seq = 0;

async function insert(userId: string, from: string, folder: string, id?: string) {
  seq += 1;
  const mid = id ?? `rh${seq}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, subject, snippet, folder, is_read, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', ?, 's', '', ?, 1, ?, ?)`,
  )
    .bind(mid, userId, `t-${mid}`, from, folder, now, now)
    .run();
  return mid;
}

function get(path: string, cookies: { session: string; csrf: string }) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
      },
    }),
    env,
    createExecutionContext(),
  );
}

describe('F14.3 rule-hint', () => {
  it('≥5 封已歸檔且佔比 ≥60% → 建議；未達門檻 → null', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    // 6 封 news@x：5 archive + 1 inbox（佔比 83%）→ 建議
    const target = await insert(hon.userId, 'news@x.com', 'inbox');
    for (let i = 0; i < 5; i++) await insert(hon.userId, 'news@x.com', 'archive');
    const res = await get(`/messages/${target}/rule-hint`, hon.cookies);
    const data = await res.json<{ hint: { fromAddr: string; archived: number } | null }>();
    expect(data.hint?.fromAddr).toBe('news@x.com');
    expect(data.hint?.archived).toBe(5);

    // 另一寄件者只有 2 封 archive → 未達 5 → null
    const low = await insert(hon.userId, 'rare@y.com', 'inbox');
    await insert(hon.userId, 'rare@y.com', 'archive');
    await insert(hon.userId, 'rare@y.com', 'archive');
    const res2 = await get(`/messages/${low}/rule-hint`, hon.cookies);
    expect((await res2.json<{ hint: unknown }>()).hint).toBeNull();
  });

  it('已有涵蓋此寄件者的規則 → 抑制（null）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const target = await insert(hon.userId, 'cov@z.com', 'inbox');
    for (let i = 0; i < 5; i++) await insert(hon.userId, 'cov@z.com', 'archive');
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at)
       VALUES ('r1', ?, 'x', ?, ?, 1, 0, ?)`,
    )
      .bind(hon.userId, JSON.stringify({ clauses: [{ field: 'from', op: 'contains', value: 'cov@z.com' }] }), JSON.stringify({ moveToFolder: 'archive' }), Date.now())
      .run();
    const res = await get(`/messages/${target}/rule-hint`, hon.cookies);
    expect((await res.json<{ hint: unknown }>()).hint).toBeNull();
  });

  it('抑制大小寫不敏感：規則 value 帶大寫仍能抑制（對齊 rulesEngine 的 toLowerCase）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const target = await insert(hon.userId, 'mix@z.com', 'inbox');
    for (let i = 0; i < 5; i++) await insert(hon.userId, 'mix@z.com', 'archive');
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at)
       VALUES ('r2', ?, 'x', ?, ?, 1, 0, ?)`,
    )
      .bind(hon.userId, JSON.stringify({ clauses: [{ field: 'from', op: 'contains', value: 'MIX@Z.com' }] }), JSON.stringify({ moveToFolder: 'archive' }), Date.now())
      .run();
    const res = await get(`/messages/${target}/rule-hint`, hon.cookies);
    expect((await res.json<{ hint: unknown }>()).hint).toBeNull();
  });

  it('使用者隔離：他人的信回 404-null（不外洩統計）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const kaiMsg = await insert(kai.userId, 'k@k.com', 'inbox');
    const res = await get(`/messages/${kaiMsg}/rule-hint`, hon.cookies);
    expect((await res.json<{ hint: unknown }>()).hint).toBeNull();
  });
});
