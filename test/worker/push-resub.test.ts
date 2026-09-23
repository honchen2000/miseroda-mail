// F1.5：推播訂閱續期 —— /push/subscribe 帶 oldEndpoint 時換掉舊（失效）訂閱，避免殘留。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function post(path: string, cookies: { session: string; csrf: string }, body: unknown) {
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
    env,
    createExecutionContext(),
  );
}

async function endpointsOf(userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint`)
    .bind(userId)
    .all<{ endpoint: string }>();
  return rows.results.map((r) => r.endpoint);
}

const SUB_A = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/aaa', p256dh: 'p256dh-a', auth: 'auth-a' };
const SUB_B = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/bbb', p256dh: 'p256dh-b', auth: 'auth-b' };

describe('push 訂閱續期（F1.5）', () => {
  it('帶 oldEndpoint → 換掉舊訂閱（新增新的、刪除舊的）', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    expect((await post('/push/subscribe', u.cookies, SUB_A)).status).toBe(200);
    expect(await endpointsOf(u.userId)).toEqual([SUB_A.endpoint]);

    // 輪換：訂閱 B 並帶 oldEndpoint=A → 只剩 B
    expect((await post('/push/subscribe', u.cookies, { ...SUB_B, oldEndpoint: SUB_A.endpoint })).status).toBe(200);
    expect(await endpointsOf(u.userId)).toEqual([SUB_B.endpoint]);
  });

  it('不帶 oldEndpoint → 維持既有行為（兩個訂閱並存）', async () => {
    const u = await seedUser(env, 'u2@miseroda.com');
    await post('/push/subscribe', u.cookies, SUB_A);
    await post('/push/subscribe', u.cookies, SUB_B);
    expect(await endpointsOf(u.userId)).toEqual([SUB_A.endpoint, SUB_B.endpoint]);
  });

  it('oldEndpoint === 新 endpoint → 不會誤刪剛 upsert 的那筆', async () => {
    const u = await seedUser(env, 'u3@miseroda.com');
    await post('/push/subscribe', u.cookies, { ...SUB_A, oldEndpoint: SUB_A.endpoint });
    expect(await endpointsOf(u.userId)).toEqual([SUB_A.endpoint]);
  });
});
