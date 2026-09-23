// F4.3b：聯絡人群組 CRUD + 成員管理 + 擁有權隔離。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

function call(u: Awaited<ReturnType<typeof seedUser>>, path: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {
    Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
    'X-CSRF-Token': u.cookies.csrf,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    createExecutionContext(),
  );
}
type Groups = { groups: { id: string; name: string; emails: string[] }[] };

describe('聯絡人群組（F4.3b）', () => {
  it('建立→設成員→改名→刪除（成員一併清）', async () => {
    const u = await seedUser(env, 'g1@miseroda.com');
    const { id } = await (await call(u, '/contact-groups', { body: { name: '家人' } })).json<{ id: string }>();
    expect(id).toBeTruthy();

    // 設成員（含重複/大小寫 → 去重小寫）
    expect((await call(u, `/contact-groups/${id}`, { method: 'PATCH', body: { emails: ['Mom@X.com', 'dad@x.com', 'mom@x.com'] } })).status).toBe(200);
    let g = (await (await call(u, '/contact-groups')).json<Groups>()).groups.find((x) => x.id === id)!;
    expect(g.emails.sort()).toEqual(['dad@x.com', 'mom@x.com']);
    expect(g.name).toBe('家人');

    // 改名（不動成員）
    await call(u, `/contact-groups/${id}`, { method: 'PATCH', body: { name: '我的家人' } });
    g = (await (await call(u, '/contact-groups')).json<Groups>()).groups.find((x) => x.id === id)!;
    expect(g.name).toBe('我的家人');
    expect(g.emails).toHaveLength(2);

    // 刪除 → 列表空 + 成員列已清
    expect((await call(u, `/contact-groups/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await (await call(u, '/contact-groups')).json<Groups>()).groups).toHaveLength(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) c FROM contact_group_members WHERE group_id = ?`).bind(id).first<{ c: number }>()).toMatchObject({ c: 0 });
  });

  it('擁有權隔離：別人不能改/刪我的群組', async () => {
    const a = await seedUser(env, 'ga@miseroda.com');
    const b = await seedUser(env, 'gb@miseroda.com');
    const { id } = await (await call(a, '/contact-groups', { body: { name: 'A 的群組' } })).json<{ id: string }>();
    expect((await call(b, `/contact-groups/${id}`, { method: 'PATCH', body: { name: '駭' } })).status).toBe(404);
    expect((await call(b, `/contact-groups/${id}`, { method: 'DELETE' })).status).toBe(404);
    // b 看不到 a 的群組
    expect((await (await call(b, '/contact-groups')).json<Groups>()).groups).toHaveLength(0);
    // a 的群組與名稱完好
    expect((await (await call(a, '/contact-groups')).json<Groups>()).groups[0].name).toBe('A 的群組');
  });

  it('schema 把關：空名 400；非法 email 被擋', async () => {
    const u = await seedUser(env, 'gc@miseroda.com');
    expect((await call(u, '/contact-groups', { body: { name: '' } })).status).toBe(400);
    const { id } = await (await call(u, '/contact-groups', { body: { name: 'x' } })).json<{ id: string }>();
    expect((await call(u, `/contact-groups/${id}`, { method: 'PATCH', body: { emails: ['not-an-email'] } })).status).toBe(400);
  });
});
