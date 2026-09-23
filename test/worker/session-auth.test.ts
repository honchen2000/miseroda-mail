// 效能迴圈 P9：auth 查詢 3 趟 D1 串行 → 1 趟 batch。驗兩件事：
//   ① 判定規則與舊版逐條相同（有效／撤銷／過期／停用／未知 token／TOTP 旗標）
//   ② 真的只剩一趟往返：一次 batch、零次單獨查詢（舊版是 sessions → users → totp_secrets 三次單獨 .first()）
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { getSessionAuth, getSessionUser } from '../../src/worker/auth/sessions';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

/**
 * 包住 env.DB，記下每一趟往返：`batch()` 一次算一趟、對 prepared statement 直接 first/all/run/raw 也各算一趟。
 * 每趟都記 SQL，讓斷言只看 **auth 那幾張表**（sessions／users／totp_secrets）——handler 自己若也用 env.DB，不會混進來。
 * handler 走的 c.var.db（withSession 回傳的物件）本來就不在這層。
 */
const AUTH_SQL = /FROM sessions WHERE id|FROM users WHERE id|FROM totp_secrets WHERE user_id/;
function countingDb(db: D1Database) {
  const trips: { kind: 'batch' | 'direct'; sql: string[] }[] = [];
  const patch = (st: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const s = st as unknown as Record<string, (...a: unknown[]) => unknown>;
    (st as unknown as { __sql: string }).__sql = sql;
    for (const m of ['first', 'all', 'run', 'raw']) {
      const orig = s[m].bind(st);
      s[m] = (...a: unknown[]) => {
        trips.push({ kind: 'direct', sql: [sql] });
        return orig(...a);
      };
    }
    const origBind = s.bind.bind(st);
    s.bind = (...a: unknown[]) => patch(origBind(...a) as D1PreparedStatement, sql);
    return st;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => patch(target.prepare(sql), sql);
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          trips.push({ kind: 'batch', sql: stmts.map((x) => (x as unknown as { __sql?: string }).__sql ?? '') });
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  /** 只算碰到 auth 表的往返。 */
  const authTrips = () => trips.filter((t) => t.sql.some((q) => AUTH_SQL.test(q)));
  return { db: proxy, trips, authTrips };
}

function req(path: string, cookies: { session: string; csrf: string }, opts: { method?: string; body?: unknown; csrf?: boolean } = {}, e: Env = env) {
  const headers: Record<string, string> = {
    Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
  };
  if (opts.csrf !== false) headers['X-CSRF-Token'] = cookies.csrf;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    e,
    createExecutionContext(),
  );
}

describe('getSessionAuth — 判定規則與舊版逐條相同', () => {
  it('有效 session → 回 session、使用者、TOTP 已啟用', async () => {
    const u = await seedUser(env, 'sa-ok@miseroda.com');
    const r = await getSessionAuth(env, u.cookies.session);
    expect(r?.user.id).toBe(u.userId);
    expect(r?.session.user_id).toBe(u.userId);
    expect(r?.totpEnabled).toBe(true);
  });

  it('TOTP 關閉或沒有 TOTP 列 → totpEnabled=false（身分本身仍有效）', async () => {
    const a = await seedUser(env, 'sa-off@miseroda.com');
    await env.DB.prepare(`UPDATE totp_secrets SET enabled = 0 WHERE user_id = ?`).bind(a.userId).run();
    expect((await getSessionAuth(env, a.cookies.session))?.totpEnabled).toBe(false);

    const b = await seedUser(env, 'sa-none@miseroda.com');
    await env.DB.prepare(`DELETE FROM totp_secrets WHERE user_id = ?`).bind(b.userId).run();
    const rb = await getSessionAuth(env, b.cookies.session);
    expect(rb?.user.id).toBe(b.userId);
    expect(rb?.totpEnabled).toBe(false);
  });

  it('兩個使用者的 TOTP 旗標不會串（子查詢以 session id 綁定）', async () => {
    const on = await seedUser(env, 'sa-on2@miseroda.com');
    const off = await seedUser(env, 'sa-off2@miseroda.com');
    await env.DB.prepare(`UPDATE totp_secrets SET enabled = 0 WHERE user_id = ?`).bind(off.userId).run();
    expect((await getSessionAuth(env, on.cookies.session))?.totpEnabled).toBe(true);
    expect((await getSessionAuth(env, off.cookies.session))?.totpEnabled).toBe(false);
  });

  it('撤銷的 session → null', async () => {
    const u = await seedUser(env, 'sa-revoked@miseroda.com');
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ?`).bind(Date.now(), u.userId).run();
    expect(await getSessionAuth(env, u.cookies.session)).toBeNull();
  });

  it('過期的 session → null', async () => {
    const u = await seedUser(env, 'sa-expired@miseroda.com');
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE user_id = ?`).bind(Date.now() - 1, u.userId).run();
    expect(await getSessionAuth(env, u.cookies.session)).toBeNull();
  });

  it('停用的使用者 → null', async () => {
    const u = await seedUser(env, 'sa-disabled@miseroda.com');
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).bind(u.userId).run();
    expect(await getSessionAuth(env, u.cookies.session)).toBeNull();
  });

  it('未知 token → null', async () => {
    expect(await getSessionAuth(env, 'no-such-token')).toBeNull();
  });

  it('getSessionUser（share-target 用）委派後結果不變：有效回身分、撤銷回 null', async () => {
    const u = await seedUser(env, 'sa-legacy@miseroda.com');
    const ok = await getSessionUser(env, u.cookies.session);
    expect(ok?.user.id).toBe(u.userId);
    expect(ok).not.toHaveProperty('totpEnabled');
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ?`).bind(Date.now(), u.userId).run();
    expect(await getSessionUser(env, u.cookies.session)).toBeNull();
  });
});

describe('getSessionAuth — 一趟往返', () => {
  // 舊版：sessions、users 兩次單獨 .first()（外加 middleware 裡 totp 一次）→ 這條會紅。
  it('一次 batch、零次單獨查詢', async () => {
    const u = await seedUser(env, 'sa-rt@miseroda.com');
    const { db, trips } = countingDb(env.DB);
    const r = await getSessionAuth({ ...env, DB: db } as Env, u.cookies.session);
    expect(r?.totpEnabled).toBe(true);
    expect(trips.map((t) => t.kind)).toEqual(['batch']);
  });

  // send／settings／ai／mail 四個 router 都掛在 '/' 且各自 use('*', requireSession)，Hono 會對同一支請求依序全跑：
  // mail 路由 4 次、ai 3 次、settings 2 次、send 1 次。修前 mail 路由量到 { batch: 4 }（舊版更是 12 次單獨查詢）。
  // handler 自己走 c.var.db（withSession 回傳的物件），不在 env.DB 的計數範圍 → 量到的正好是 auth 這一段。
  it.each([
    ['mail（第 4 層）', '/mailbox/counts'],
    ['ai（第 3 層）', '/messages/nonexistent/auto-draft'],
    ['settings（第 2 層）', '/rules'],
    ['send（第 1 層）', '/identities'],
  ])('%s 的請求在 env.DB 上只有 1 次 auth batch、0 次單獨查詢', async (_label, path) => {
    const u = await seedUser(env, `sa-rt-${path.length}@miseroda.com`);
    const { db, authTrips } = countingDb(env.DB);
    const res = await req(path, u.cookies, {}, { ...env, DB: db } as Env);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(401);
    expect(authTrips().map((t) => t.kind)).toEqual(['batch']);
  });
});

describe('requireSession — 判定順序不變（demo → CSRF → TOTP）', () => {
  it('TOTP 未啟用：一般端點 403 mfa_setup_required，白名單 /auth/me 200', async () => {
    const u = await seedUser(env, 'sa-mfa@miseroda.com');
    await env.DB.prepare(`UPDATE totp_secrets SET enabled = 0 WHERE user_id = ?`).bind(u.userId).run();
    const blocked = await req('/mailbox/counts', u.cookies);
    expect(blocked.status).toBe(403);
    expect((await blocked.json<{ error: string }>()).error).toBe('mfa_setup_required');
    expect((await req('/auth/me', u.cookies)).status).toBe(200);
  });

  it('TOTP 未啟用又缺 CSRF 的變更請求 → 先報 csrf_mismatch（CSRF 檢查在 TOTP gate 之前）', async () => {
    const u = await seedUser(env, 'sa-order@miseroda.com');
    await env.DB.prepare(`UPDATE totp_secrets SET enabled = 0 WHERE user_id = ?`).bind(u.userId).run();
    const res = await req('/saved-searches', u.cookies, { body: { name: 'x', query: 'y' }, csrf: false });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('csrf_mismatch');
  });

  it('撤銷 session 後同一支請求立刻 401（沒有任何快取延遲撤銷）', async () => {
    const u = await seedUser(env, 'sa-revoke2@miseroda.com');
    expect((await req('/mailbox/counts', u.cookies)).status).toBe(200);
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ?`).bind(Date.now(), u.userId).run();
    expect((await req('/mailbox/counts', u.cookies)).status).toBe(401);
  });

  it('demo 帳號：TOTP 關閉仍可讀（免 MFA gate），變更請求 403 demo_readonly', async () => {
    const u = await seedUser(env, 'sa-demo@miseroda.com');
    await env.DB.prepare(`UPDATE users SET is_demo = 1 WHERE id = ?`).bind(u.userId).run();
    await env.DB.prepare(`UPDATE totp_secrets SET enabled = 0 WHERE user_id = ?`).bind(u.userId).run();
    expect((await req('/mailbox/counts', u.cookies)).status).toBe(200);
    const w = await req('/saved-searches', u.cookies, { body: { name: 'x', query: 'y' } });
    expect(w.status).toBe(403);
    expect((await w.json<{ error: string }>()).error).toBe('demo_readonly');
  });
});
