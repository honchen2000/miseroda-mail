// F4.5：標籤階層（parent_id 限 2 層）+ 自訂排序（sort_order）。
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
type Labels = { labels: { id: string; name: string; parentId: string | null; sortOrder: number }[] };
const mkLabel = (u: Awaited<ReturnType<typeof seedUser>>, body: unknown) => call(u, '/labels', { body: { color: '#5FF6C2', ...(body as object) } });

describe('標籤階層 + 排序（F4.5）', () => {
  it('建巢狀（帳單/水電）+ sort_order 排序 + counts 回 parentId', async () => {
    const u = await seedUser(env, 'lh1@miseroda.com');
    const bill = await (await mkLabel(u, { name: '帳單', sortOrder: 1 })).json<{ id: string }>();
    const util = await (await mkLabel(u, { name: '水電', parentId: bill.id, sortOrder: 0 })).json<{ id: string }>();
    await mkLabel(u, { name: '工作', sortOrder: 0 }); // sort 0 → 排在帳單(1)前
    const counts = await (await call(u, '/mailbox/counts')).json<Labels>();
    const child = counts.labels.find((l) => l.id === util.id)!;
    expect(child.parentId).toBe(bill.id);
    // 排序：sort_order 升冪（工作 0、水電 0、帳單 1）；前兩個 sort_order=0
    expect(counts.labels[counts.labels.length - 1].name).toBe('帳單'); // 帳單 sort_order=1 在最後
  });

  it('限 2 層：父標籤須頂層；3 層被擋', async () => {
    const u = await seedUser(env, 'lh2@miseroda.com');
    const top = await (await mkLabel(u, { name: 'A' })).json<{ id: string }>();
    const mid = await (await mkLabel(u, { name: 'B', parentId: top.id })).json<{ id: string }>(); // 合法 2 層
    expect(mid.id).toBeTruthy();
    // 用 mid（已是子）當父 → 3 層 → 400
    expect((await mkLabel(u, { name: 'C', parentId: mid.id })).status).toBe(400);
  });

  it('PATCH：設父標籤；有子標籤者不可變成子；自己不能當自己父', async () => {
    const u = await seedUser(env, 'lh3@miseroda.com');
    const p = await (await mkLabel(u, { name: 'P' })).json<{ id: string }>();
    const q = await (await mkLabel(u, { name: 'Q' })).json<{ id: string }>();
    // q 設父為 p → 200
    expect((await call(u, `/labels/${q.id}`, { method: 'PATCH', body: { parentId: p.id } })).status).toBe(200);
    // p 有子(q) → 把 p 變成別人的子 → 400 has_children
    const r = await (await mkLabel(u, { name: 'R' })).json<{ id: string }>();
    expect((await call(u, `/labels/${p.id}`, { method: 'PATCH', body: { parentId: r.id } })).status).toBe(400);
    // 自己當自己父 → 400
    expect((await call(u, `/labels/${r.id}`, { method: 'PATCH', body: { parentId: r.id } })).status).toBe(400);
  });

  it('空字串 parentId 正規化為 null（不存非法父值）[Codex]', async () => {
    const u = await seedUser(env, 'lhe@miseroda.com');
    const x = await (await mkLabel(u, { name: 'X', parentId: '' })).json<{ id: string }>(); // '' → 頂層
    const p = await (await mkLabel(u, { name: 'P' })).json<{ id: string }>();
    await call(u, `/labels/${x.id}`, { method: 'PATCH', body: { parentId: p.id } }); // 設父
    await call(u, `/labels/${x.id}`, { method: 'PATCH', body: { parentId: '' } }); // '' → 清為頂層
    const counts = await (await call(u, '/mailbox/counts')).json<Labels>();
    expect(counts.labels.find((l) => l.id === x.id)?.parentId).toBeNull();
  });

  it('擁有權：不能用別人的標籤當父', async () => {
    const a = await seedUser(env, 'lha@miseroda.com');
    const b = await seedUser(env, 'lhb@miseroda.com');
    const bLabel = await (await mkLabel(b, { name: 'B頂層' })).json<{ id: string }>();
    expect((await mkLabel(a, { name: 'X', parentId: bLabel.id })).status).toBe(400);
  });
});
