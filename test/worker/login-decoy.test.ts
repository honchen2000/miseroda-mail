// F16.4 / 2026-09-20 掃描 F6+F7：/auth/login/options 的帳號枚舉。
// 情境逐條對應 docs/product-roadmap.md F16.4 的「驗證」欄。
// 最重要的一條是「誘餌不得取樣真實資料」——前一輪就是為了讓誘餌像真的而去 SELECT credentials，
// 結果反而讓未認證者能讀回站上真實的 passkey 數量與 id 長度分布，整個 patch 因此被退。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { decoyCredentialIds } from '../../src/worker/auth/loginDecoy';
import { seedUser } from './helpers/fixtures';

const uniq = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

async function loginOptions(email: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request('https://mail.miseroda.com/api/v1/auth/login/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { options: { allowCredentials?: { id: string }[] } };
  return (body.options.allowCredentials ?? []).map((x) => x.id);
}

describe('登入枚舉誘餌（F16.4）', () => {
  it('未知帳號不再回空陣列——回一組非空的誘餌', async () => {
    const ids = await loginOptions(`nobody-${uniq()}@miseroda.com`);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((s) => /^[A-Za-z0-9_-]+$/.test(s))).toBe(true); // 形狀是 base64url
  });

  it('同一 email 的誘餌恆定，且大小寫與前後空白不敏感', async () => {
    const e = `same-${uniq()}@miseroda.com`;
    const a = await decoyCredentialIds(env, e);
    const b = await decoyCredentialIds(env, `  ${e.toUpperCase()}  `);
    expect(a).toEqual(b);
    expect(a).toEqual(await loginOptions(e)); // 端點回的就是同一組
  });

  it('不同 email 得到不同誘餌', async () => {
    const a = await decoyCredentialIds(env, `a-${uniq()}@miseroda.com`);
    const b = await decoyCredentialIds(env, `b-${uniq()}@miseroda.com`);
    expect(a).not.toEqual(b);
  });

  it('誘餌形狀落在寫死的 profile 內（數量 1~2、長度 22/27/43），不是即時取樣來的', async () => {
    for (let i = 0; i < 40; i++) {
      const ids = await decoyCredentialIds(env, `shape-${i}-${uniq()}@miseroda.com`);
      expect(ids.length).toBeGreaterThanOrEqual(1);
      expect(ids.length).toBeLessThanOrEqual(2);
      for (const s of ids) expect([22, 27, 43]).toContain(s.length);
    }
  });

  it('真帳號的回應逐字不變：回的是真實 credential id，不摻誘餌', async () => {
    const email = `real-${uniq()}@miseroda.com`;
    const u = await seedUser(env, email);
    const realId = `cred-${uniq()}`;
    await env.DB.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, name, created_at)
       VALUES (?, ?, 'pk', 0, '', 'k', ?)`,
    ).bind(realId, u.userId, Date.now()).run();
    expect(await loginOptions(email)).toEqual([realId]);
  });

  it('誘餌不會與真實 id 碰撞（真帳號查到的是自己的，不是誘餌）', async () => {
    const email = `nc-${uniq()}@miseroda.com`;
    const decoys = await decoyCredentialIds(env, email);
    const u = await seedUser(env, email);
    const realId = `cred-${uniq()}`;
    await env.DB.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, name, created_at)
       VALUES (?, ?, 'pk', 0, '', 'k', ?)`,
    ).bind(realId, u.userId, Date.now()).run();
    expect(decoys).not.toContain(realId);
    expect(await loginOptions(email)).toEqual([realId]);
  });

  it('停用帳號不洩漏真實 id——走誘餌，與未知帳號無從區分', async () => {
    const email = `dis-${uniq()}@miseroda.com`;
    const u = await seedUser(env, email);
    const realId = `cred-${uniq()}`;
    await env.DB.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, name, created_at)
       VALUES (?, ?, 'pk', 0, '', 'k', ?)`,
    ).bind(realId, u.userId, Date.now()).run();
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).bind(u.userId).run();
    const ids = await loginOptions(email);
    expect(ids).not.toContain(realId);
    expect(ids).toEqual(await decoyCredentialIds(env, email));
  });

  it('真帳號但零憑證也走誘餌（回空會洩漏該帳號存在）', async () => {
    const email = `zero-${uniq()}@miseroda.com`;
    await seedUser(env, email);
    expect(await loginOptions(email)).toEqual(await decoyCredentialIds(env, email));
  });
});
