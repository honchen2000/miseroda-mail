// F4.4：多重簽名 — 純渲染函式 + 後端 CRUD/綁定/擁有權/預設解析。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { signatureBlockHtml, signatureText } from '../../src/app/lib/signature';

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
type Sigs = { signatures: { id: string; name: string; content: string; isDefault: boolean }[] };
type Idents = { aliases: { id: string; address: string; signatureId: string | null }[] };
const addAlias = (userId: string, id: string, addr: string) =>
  env.DB.prepare(`INSERT INTO aliases (id, user_id, address, created_by, created_at) VALUES (?, ?, ?, ?, 0)`).bind(id, userId, addr, userId).run();

describe('signature 渲染（純函式）', () => {
  it('signatureBlockHtml：escape + nl2br + 標記區塊；空→空', () => {
    expect(signatureBlockHtml('')).toBe('');
    expect(signatureBlockHtml('   ')).toBe('');
    expect(signatureBlockHtml('Hi\n<b>&')).toBe('<div data-sig="1">Hi<br>&lt;b&gt;&amp;</div>');
  });
  it('signatureText：前置兩換行；空→空', () => {
    expect(signatureText('')).toBe('');
    expect(signatureText('  ')).toBe('');
    expect(signatureText('Best')).toBe('\n\nBest');
  });
});

describe('signatures API（F4.4）', () => {
  it('CRUD + 預設互斥 + /me 用預設內容', async () => {
    const u = await seedUser(env, 's1@miseroda.com');
    const a = await (await call(u, '/signatures', { body: { name: '工作', content: 'Best, Work' } })).json<{ id: string }>();
    const b = await (await call(u, '/signatures', { body: { name: '私人', content: 'Cheers', isDefault: true } })).json<{ id: string }>();
    let list = (await (await call(u, '/signatures')).json<Sigs>()).signatures;
    expect(list.find((s) => s.id === b.id)?.isDefault).toBe(true);
    expect((await (await call(u, '/auth/me')).json<{ signature: string }>()).signature).toBe('Cheers'); // /me=預設內容
    // 把 a 設預設 → b 不再預設（互斥）
    await call(u, `/signatures/${a.id}`, { method: 'PATCH', body: { isDefault: true } });
    list = (await (await call(u, '/signatures')).json<Sigs>()).signatures;
    expect(list.find((s) => s.id === a.id)?.isDefault).toBe(true);
    expect(list.find((s) => s.id === b.id)?.isDefault).toBe(false);
    expect((await (await call(u, '/auth/me')).json<{ signature: string }>()).signature).toBe('Best, Work');
  });

  it('綁定別名→簽名 + /identities 回 signatureId + 刪簽名自動解綁', async () => {
    const u = await seedUser(env, 's2@miseroda.com');
    await addAlias(u.userId, 'al1', 's2+work@miseroda.com');
    const sig = await (await call(u, '/signatures', { body: { name: '工作', content: 'W' } })).json<{ id: string }>();
    expect((await call(u, '/signatures/bind', { method: 'PUT', body: { aliasId: 'al1', signatureId: sig.id } })).status).toBe(200);
    let idents = (await (await call(u, '/identities')).json<Idents>()).aliases;
    expect(idents.find((a) => a.id === 'al1')?.signatureId).toBe(sig.id);
    await call(u, `/signatures/${sig.id}`, { method: 'DELETE' }); // 刪簽名 → 解綁
    idents = (await (await call(u, '/identities')).json<Idents>()).aliases;
    expect(idents.find((a) => a.id === 'al1')?.signatureId).toBeNull();
  });

  it('擁有權/驗證：別人不能改我簽名(404)；綁不存在簽名(400)；綁別人別名(404)', async () => {
    const a = await seedUser(env, 'sa@miseroda.com');
    const b = await seedUser(env, 'sb@miseroda.com');
    const sig = await (await call(a, '/signatures', { body: { name: 'x', content: '' } })).json<{ id: string }>();
    expect((await call(b, `/signatures/${sig.id}`, { method: 'PATCH', body: { name: 'hack' } })).status).toBe(404);
    expect((await call(b, `/signatures/${sig.id}`, { method: 'DELETE' })).status).toBe(404);
    await addAlias(a.userId, 'al2', 'sa+x@miseroda.com');
    expect((await call(a, '/signatures/bind', { method: 'PUT', body: { aliasId: 'al2', signatureId: 'nope' } })).status).toBe(400);
    expect((await call(b, '/signatures/bind', { method: 'PUT', body: { aliasId: 'al2', signatureId: null } })).status).toBe(404);
  });
});
