// AI 改寫 / 建議主旨路由：mock AI binding、輸入驗證、引號清理、失敗回 502。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';
function aiEnv(response: unknown) {
  return { ...env, AI: { run: async () => ({ response }) }, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
}
function post(path: string, cookies: { session: string; csrf: string }, targetEnv: typeof env, body: unknown) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    targetEnv,
    createExecutionContext(),
  );
}

describe('AI rewrite / subject', () => {
  it('改寫：回傳改寫後正文；壞 mode / 空字串 → 400', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const e = aiEnv('您好，謹此致意。');
    const r = await post('/ai/rewrite', hon.cookies, e, { text: '嗨', mode: 'formal' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: '您好，謹此致意。' });
    expect((await post('/ai/rewrite', hon.cookies, e, { text: '嗨', mode: 'nope' })).status).toBe(400);
    expect((await post('/ai/rewrite', hon.cookies, e, { text: '', mode: 'formal' })).status).toBe(400);
  });

  it('建議主旨：去除引號與多餘空白', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const e = aiEnv('「  本週會議通知  」');
    const r = await post('/ai/subject', hon.cookies, e, { text: '禮拜三開會' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ subject: '本週會議通知' });
  });

  it('AI 失敗（非字串回應）→ 502', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const e = aiEnv(null);
    expect((await post('/ai/rewrite', hon.cookies, e, { text: '嗨', mode: 'polish' })).status).toBe(502);
    expect((await post('/ai/subject', hon.cookies, e, { text: '嗨' })).status).toBe(502);
  });
});
