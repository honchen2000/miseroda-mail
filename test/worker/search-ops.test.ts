// 搜尋運算子（cc:/bcc:/subject: + 欄位內 | OR）+ 儲存搜尋 CRUD（含跨使用者隔離）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';
function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
}

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
    quietEnv(),
    createExecutionContext(),
  );
}

async function searchItems(path: string, cookies: { session: string; csrf: string }) {
  const r = await (await apiCall(path, cookies)).json<{ items: { id: string; subject: string }[] }>();
  return r.items;
}

describe('search operators', () => {
  it('cc: / subject: / from 的 | OR / bcc:', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    await worker.email(
      mockEmailMessage(plainEmail({ to: 'hon@miseroda.com', from: 'alice@x.com', subject: '報價單' })).message,
      quietEnv(),
      createExecutionContext(),
    );
    await worker.email(
      mockEmailMessage(
        plainEmail({ to: 'hon@miseroda.com', from: 'bob@y.com', subject: '會議通知', extraHeaders: ['Cc: <carol@z.com>'] }),
      ).message,
      quietEnv(),
      createExecutionContext(),
    );

    // subject: 子字串（LIKE，中文 OK）
    const subj = await searchItems(`/messages?folder=inbox&subject=${encodeURIComponent('報價')}`, hon.cookies);
    expect(subj.map((i) => i.subject)).toEqual(['報價單']);

    // cc: 只比對 cc_addrs
    const cc = await searchItems('/messages?folder=inbox&cc=carol', hon.cookies);
    expect(cc.length).toBe(1);
    expect(cc[0].subject).toBe('會議通知');

    // from 的 | OR：alice|bob → 兩封都中
    const both = await searchItems(`/messages?folder=inbox&from=${encodeURIComponent('alice|bob')}`, hon.cookies);
    expect(both.length).toBe(2);

    // bcc: 直接設一封的 bcc_addrs，驗證查詢路徑（入站不存 bcc，故手動塞）
    const msgId = (await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? AND subject = '會議通知'`)
      .bind(hon.userId)
      .first<{ id: string }>())!.id;
    await env.DB.prepare(`UPDATE messages SET bcc_addrs = ? WHERE id = ?`)
      .bind(JSON.stringify(['secret@hidden.com']), msgId)
      .run();
    const bcc = await searchItems('/messages?folder=inbox&bcc=secret', hon.cookies);
    expect(bcc.map((i) => i.id)).toEqual([msgId]);
  });
});

describe('saved searches CRUD', () => {
  it('建立 / 列出 / 刪除 + 跨使用者隔離 + 壞輸入擋下', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');

    const created = await apiCall('/saved-searches', hon.cookies, {
      body: { name: '未讀附件', query: 'is:unread has:attachment' },
    });
    expect(created.status).toBe(200);
    const { id } = await created.json<{ id: string }>();

    // hon 看得到、kai 看不到
    const honList = await (await apiCall('/saved-searches', hon.cookies)).json<{ searches: { id: string }[] }>();
    expect(honList.searches.map((s) => s.id)).toContain(id);
    const kaiList = await (await apiCall('/saved-searches', kai.cookies)).json<{ searches: { id: string }[] }>();
    expect(kaiList.searches.length).toBe(0);

    // kai 不能刪 hon 的 → 404
    expect((await apiCall(`/saved-searches/${id}`, kai.cookies, { method: 'DELETE' })).status).toBe(404);

    // hon 刪除 → 200，之後清單為空
    expect((await apiCall(`/saved-searches/${id}`, hon.cookies, { method: 'DELETE' })).status).toBe(200);
    const after = await (await apiCall('/saved-searches', hon.cookies)).json<{ searches: unknown[] }>();
    expect(after.searches.length).toBe(0);

    // 空名稱/空查詢 → 400
    expect((await apiCall('/saved-searches', hon.cookies, { body: { name: '', query: '' } })).status).toBe(400);
  });

  it('F5.6a：釘/取消釘到側欄 + 跨使用者擋下', async () => {
    const hon = await seedUser(env, 'pin-hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'pin-kai@miseroda.com');
    const { id } = await (await apiCall('/saved-searches', hon.cookies, { body: { name: '學校', query: 'from:school' } })).json<{ id: string }>();

    const pinned = (l: { searches: { id: string; pinned: boolean }[] }) => l.searches.find((s) => s.id === id)?.pinned;
    // 預設未釘
    expect(pinned(await (await apiCall('/saved-searches', hon.cookies)).json())).toBe(false);
    // 釘
    expect((await apiCall(`/saved-searches/${id}`, hon.cookies, { method: 'PATCH', body: { pinned: true } })).status).toBe(200);
    expect(pinned(await (await apiCall('/saved-searches', hon.cookies)).json())).toBe(true);
    // 取消釘
    expect((await apiCall(`/saved-searches/${id}`, hon.cookies, { method: 'PATCH', body: { pinned: false } })).status).toBe(200);
    expect(pinned(await (await apiCall('/saved-searches', hon.cookies)).json())).toBe(false);
    // kai 不能釘 hon 的 → 404
    expect((await apiCall(`/saved-searches/${id}`, kai.cookies, { method: 'PATCH', body: { pinned: true } })).status).toBe(404);
    // 壞 body → 400
    expect((await apiCall(`/saved-searches/${id}`, hon.cookies, { method: 'PATCH', body: { pinned: 'yes' } })).status).toBe(400);
  });
});
