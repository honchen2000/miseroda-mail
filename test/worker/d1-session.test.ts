// D1 讀取複本用的 per-request session（`dbSession` 中介層）。
//
// 本階段讀取複本仍**關閉**，所有查詢一律走主庫 → 這些測試立的是「行為零改變」的基準：
// 加了 session 機制之後，既有流程必須完全照舊，同時 bookmark 往返要正確、壞值要打不倒它。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import { Hono } from 'hono';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { BOOKMARK_HEADER, dbSession, parseBookmark, type Vars } from '../../src/worker/api/middleware';

const BASE = 'https://mail.miseroda.com/api/v1';

function req(
  path: string,
  cookies?: { session: string; csrf: string },
  opts: { method?: string; body?: unknown; bookmark?: string; headers?: Record<string, string> } = {},
  extraEnv: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (cookies) {
    headers.Cookie = `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`;
    headers['X-CSRF-Token'] = cookies.csrf;
  }
  if (opts.bookmark !== undefined) headers[BOOKMARK_HEADER] = opts.bookmark;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    { ...env, ...extraEnv } as typeof env,
    createExecutionContext(),
  );
}

describe('D1 session 中介層', () => {
  it('查了 DB 的請求回應帶 bookmark；完全不碰 DB 的請求不帶', async () => {
    const u = await seedUser(env, 'dbs-bookmark@miseroda.com');

    const read = await req('/messages?folder=inbox', u.cookies);
    expect(read.status).toBe(200);
    const bm = read.headers.get(BOOKMARK_HEADER);
    expect(bm, '有查 DB 的請求必須帶回 bookmark').toBeTruthy();

    // /health 在 requireSession 之外、且不查 DB → getBookmark() 為 null → 不該憑空生出標頭
    const health = await req('/health');
    expect(health.status).toBe(200);
    expect(health.headers.get(BOOKMARK_HEADER)).toBeNull();
  });

  it('把回應的 bookmark 原樣帶回下一個請求 → 照常成功並再帶回一個', async () => {
    const u = await seedUser(env, 'dbs-roundtrip@miseroda.com');
    const first = await req('/mailbox/counts', u.cookies);
    const bm = first.headers.get(BOOKMARK_HEADER);
    expect(bm).toBeTruthy();

    const second = await req('/mailbox/counts', u.cookies, { bookmark: bm! });
    expect(second.status, 'bookmark 往返不得改變結果').toBe(200);
    expect(second.headers.get(BOOKMARK_HEADER)).toBeTruthy();
  });

  it('壞掉的 bookmark 不會把使用者鎖在門外（守門 → 靜默忽略）', async () => {
    const u = await seedUser(env, 'dbs-badbookmark@miseroda.com');
    const junk = [
      'not-a-bookmark',                            // 非十六進位
      '',                                          // 空字串
      'x'.repeat(500),                             // 超長
      'apac1.00000001-00000002-00000003-!@#$%^&*', // tag 對但格式不合法
      'apac1.' + 'x'.repeat(500),                  // tag 對但超長
      // ⚠️ 回歸守門（LESSONS L9，2026-07-24 實測 500）：**別的資料庫**發的 bookmark。
      // 遷庫後所有舊分頁的 localStorage 都握著這種值；沒有 tag 守門就是每個請求 500。
      '000000ab-00000008-000050b2-f8ebcf53a7846a001409438e9f721e62', // 遷庫前的無 tag 舊格式
      'wnam0.000000ab-00000008-000050b2-f8ebcf53a7846a001409438e9f721e62', // 別的世代 tag
    ];
    for (const bad of junk) {
      const res = await req('/mailbox/counts', u.cookies, { bookmark: bad });
      expect(res.status, `bookmark=${bad.slice(0, 32)} 必須照常服務`).toBe(200);
    }
  });

  it('bookmark 一律帶世代 tag 出去（遷庫時改 tag 即可讓全世界的舊 bookmark 失效）', async () => {
    const u = await seedUser(env, 'dbs-tag@miseroda.com');
    const res = await req('/mailbox/counts', u.cookies);
    const bm = res.headers.get(BOOKMARK_HEADER);
    expect(bm, '有查 DB 就該帶回 bookmark').toBeTruthy();
    expect(bm!.startsWith('apac1.'), `回應的 bookmark 必須帶 tag，實際：${bm}`).toBe(true);
    // 純函式層：只有 tag 相符才解析得出來
    expect(parseBookmark(bm!)).toBe(bm!.slice('apac1.'.length));
    expect(parseBookmark('other.' + bm!.slice('apac1.'.length))).toBeUndefined();
    expect(parseBookmark(bm!.slice('apac1.'.length))).toBeUndefined(); // 無 tag 的舊格式
  });

  it('讀你所寫基準：PATCH 之後立刻 GET 看得到（複本關閉時本就成立）', async () => {
    const u = await seedUser(env, 'dbs-rww@miseroda.com');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, received_at, created_at)
       VALUES ('msg-rww', ?, 'thr-rww', 'inbound', 'a@example.com', 'A', '讀你所寫', '', 'inbox', ?, ?)`,
    )
      .bind(u.userId, now, now)
      .run();

    const patch = await req('/messages/msg-rww', u.cookies, { method: 'PATCH', body: { starred: true } });
    expect(patch.status).toBe(200);
    const bm = patch.headers.get(BOOKMARK_HEADER);
    expect(bm, '變更請求必須帶回 bookmark，否則前端沒有起點').toBeTruthy();

    const after = await req('/messages?folder=inbox', u.cookies, { bookmark: bm! });
    expect(after.status).toBe(200);
    const items = (await after.json<{ items: { id: string; starred: boolean }[] }>()).items;
    expect(items.find((m) => m.id === 'msg-rww')?.starred, '標了星立刻讀回來必須是已加星').toBe(true);
  });

  it('登入是起點：demo-login 後立刻打 /auth/me 不會 401（auth 走主庫）', async () => {
    const demo = await seedUser(env, 'dbs-demo@miseroda.com');
    await env.DB.prepare(`UPDATE users SET is_demo = 1 WHERE id = ?`).bind(demo.userId).run();
    await env.DB.prepare(`UPDATE totp_secrets SET enabled = 0 WHERE user_id = ?`).bind(demo.userId).run();

    const login = await req('/auth/demo-login', undefined, { body: {} }, { DEMO_USER_ID: demo.userId });
    expect(login.status).toBe(200);

    // 從 Set-Cookie 取出剛發的 session，模擬前端「登入完成 → 下一個請求」
    const setCookie = login.headers.get('Set-Cookie') ?? '';
    const token = /__Host-session=([^;]+)/.exec(setCookie)?.[1];
    expect(token, '登入必須發出 session cookie').toBeTruthy();

    const me = await req(
      '/auth/me',
      { session: decodeURIComponent(token!), csrf: 'x' },
      { bookmark: login.headers.get(BOOKMARK_HEADER) ?? undefined },
      { DEMO_USER_ID: demo.userId },
    );
    expect(me.status, '剛登入就被 401 = 把使用者鎖在門外，最高禁忌').toBe(200);
  });

  // 回歸守門：`/realtime` 把 DO 的 WebSocket 升級回應原樣轉出，那種回應的 headers 是 immutable，
  // 對它 set() 會丟 TypeError。真的接 DO 會踩到 vitest-pool-workers 的 isolated storage 已知問題
  // （WS 測試因此獨立在 test/realtime/），所以這裡用同樣 immutable 的 Response.redirect 打同一個中介層。
  // 若有人把中介層的 try/catch 拿掉，這個 it 會直接以例外收場。
  it('回應標頭 immutable 時，寫 bookmark 失敗必須被吞掉（不能變成 500）', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Vars }>();
    app.use('*', dbSession);
    app.get('/immutable', async (c) => {
      await c.var.db.prepare(`SELECT 1`).first(); // 先查一次 → 產生 bookmark，逼中介層去寫標頭
      return Response.redirect('https://mail.miseroda.com/', 302);
    });
    const res = await app.fetch(new Request('https://mail.miseroda.com/immutable'), env);
    expect(res.status).toBe(302);
  });
});
