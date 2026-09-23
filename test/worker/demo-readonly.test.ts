// 唯讀 demo 帳號：可讀信箱、所有變更請求 403 demo_readonly；demo-login 預設關閉/縱深防禦。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function req(path: string, cookies: { session: string; csrf: string }, opts: { method?: string; body?: unknown } = {}, extraEnv: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
    'X-CSRF-Token': cookies.csrf, // 帶「有效」CSRF：證明 403 來自 demo 守門而非 csrf_mismatch
  };
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

async function makeDemo(email: string) {
  const u = await seedUser(env, email);
  await env.DB.prepare(`UPDATE users SET is_demo = 1 WHERE id = ?`).bind(u.userId).run();
  // 拔掉 TOTP：證明 demo 免 MFA gate 也能讀（一般帳號無 TOTP 會被擋 mfa_setup_required）
  await env.DB.prepare(`UPDATE totp_secrets SET enabled = 0 WHERE user_id = ?`).bind(u.userId).run();
  return u;
}

describe('demo 唯讀守門', () => {
  it('可讀信箱與 /me（isDemo:true），免 MFA gate', async () => {
    const demo = await makeDemo('demo@miseroda.com');
    const me = await req('/auth/me', demo.cookies);
    expect(me.status).toBe(200);
    expect((await me.json<{ isDemo: boolean }>()).isDemo).toBe(true);
    expect((await req('/messages?folder=inbox', demo.cookies)).status).toBe(200);
    expect((await req('/mailbox/counts', demo.cookies)).status).toBe(200);
  });

  it('所有變更請求（send/batch/settings/PATCH/passkey 刪除/AI）一律 403 demo_readonly', async () => {
    const demo = await makeDemo('demo2@miseroda.com');
    const mutations: [string, { method?: string; body?: unknown }][] = [
      ['/messages/send', { body: { to: ['x@example.com'], subject: 's', bodyHtml: '<p>hi</p>' } }], // 真信寄送（SEND_QUEUE）——最大風險
      ['/messages/batch', { body: { ids: ['x'], patch: { folder: 'archive' } } }],
      ['/settings', { method: 'PATCH', body: { prefs: { theme: 'dark' } } }],
      ['/messages/some-id', { method: 'PATCH', body: { starred: true } }],
      ['/passkeys/some-id', { method: 'DELETE' }],
      ['/ai/compose', { body: { prompt: 'hi' } }],
      ['/share/upload', { body: {} }], // 公開分享連結上傳
    ];
    for (const [path, opts] of mutations) {
      const res = await req(path, demo.cookies, opts);
      expect(res.status, `${opts.method ?? 'POST'} ${path}`).toBe(403);
      expect((await res.json<{ error: string }>()).error, path).toBe('demo_readonly');
    }
  });

  it('允許登出（撤銷自己的 demo session、離場）', async () => {
    const demo = await makeDemo('demo-logout@miseroda.com');
    const res = await req('/auth/logout', demo.cookies, { body: {} });
    expect(res.status).toBe(200); // logout 是唯一放行的變更請求
    // session 已撤銷：後續請求 401
    expect((await req('/auth/me', demo.cookies)).status).toBe(401);
  });

  it('BLOCKER 回歸：POST /share-target（Hono 之外的寫入端）擋 demo → 不寫資料', async () => {
    // 關鍵：demo 帳號 TOTP「啟用」（真實建帳法：先走完整註冊含 TOTP，事後才翻 is_demo=1）。
    // 這樣 handleShareTarget 的 TOTP 檢查會通過，真正擋下的是新加的 is_demo 守門——否則測試會假綠（被 TOTP 擋而非 is_demo）。
    const demo = await seedUser(env, 'demo-share@miseroda.com'); // seedUser 預設 TOTP enabled=1
    await env.DB.prepare(`UPDATE users SET is_demo = 1 WHERE id = ?`).bind(demo.userId).run();
    // 帶合法 session cookie 打 /share-target（multipart，含檔案）——demo 應被導回登入（302），不得寫入。
    // 含 File：成功路徑會 INSERT attachments，故 count 能真正區分「被擋(0)」vs「寫入(1)」，非假綠。
    const form = new FormData();
    form.set('text', 'hi');
    form.set('files', new File([new Uint8Array([1, 2, 3, 4])], 'x.txt', { type: 'text/plain' }));
    const res = await worker.fetch(
      new Request('https://mail.miseroda.com/share-target', {
        method: 'POST',
        headers: { Cookie: `__Host-session=${encodeURIComponent(demo.cookies.session)}` },
        body: form,
        redirect: 'manual',
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(302); // toLogin()：擋下、未寫入（非 200 完成）
    // 確認沒有為 demo 建任何 attachment
    const atts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?`).bind(demo.userId).first<{ n: number }>();
    expect(atts!.n).toBe(0);
  });

  it('一般帳號不受影響：GET 正常、變更請求非 demo_readonly', async () => {
    const normal = await seedUser(env, 'normal@miseroda.com'); // 一般帳號，is_demo=0，TOTP 啟用
    expect((await req('/messages?folder=inbox', normal.cookies)).status).toBe(200);
    // 一般帳號的變更請求可能因其他驗證失敗，但「絕不」是 demo_readonly
    const patch = await req('/settings', normal.cookies, { method: 'PATCH', body: { prefs: { theme: 'dark' } } });
    expect(patch.status).toBe(200); // settings 正常寫入
  });
});

describe('demo-login 端點', () => {
  it('DEMO_USER_ID 未設 → 404（功能關閉）', async () => {
    const res = await worker.fetch(
      new Request(`${BASE}/auth/demo-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      env, // 不含 DEMO_USER_ID
      createExecutionContext(),
    );
    expect(res.status).toBe(404);
  });

  it('DEMO_USER_ID 指向 active demo 帳號 → 發 session；指向非 demo 帳號 → 404（縱深防禦）', async () => {
    const demo = await makeDemo('demo3@miseroda.com');
    const real = await seedUser(env, 'real@miseroda.com'); // is_demo=0

    // 指向真帳號 → 拒發（絕不對非 demo 帳號發 passwordless session）
    const bad = await worker.fetch(
      new Request(`${BASE}/auth/demo-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      { ...env, DEMO_USER_ID: real.userId } as typeof env,
      createExecutionContext(),
    );
    expect(bad.status).toBe(404);

    // 指向 demo 帳號 → 200 + 發 __Host-session cookie
    const ok = await worker.fetch(
      new Request(`${BASE}/auth/demo-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      { ...env, DEMO_USER_ID: demo.userId } as typeof env,
      createExecutionContext(),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Set-Cookie') ?? '').toContain('__Host-session=');
  });
});
