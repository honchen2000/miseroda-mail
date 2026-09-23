// F5：Web Push 訂閱與 session 同壽 —— 登出／撤銷 session 之後，那台裝置不該再收到寄件者＋主旨。
// 同樣重要的另一半：仍登入中的其他裝置（含 0049 之前建立、未綁 session 的舊列）必須照常收到。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { bufToB64url, randomBytes, randomToken, sha256Hex } from '../../src/worker/lib/crypto';
import { newId } from '../../src/worker/lib/ids';
import { exportRawKey, pushToUser } from '../../src/worker/lib/webpush';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

type Cookies = { session: string; csrf: string };

function post(path: string, cookies: Cookies, body: unknown) {
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

/** 同一位使用者的第二台裝置：再開一個 session（比照 fixtures.seedUser 的寫法） */
async function addSession(userId: string): Promise<{ id: string; cookies: Cookies }> {
  const token = randomToken();
  const now = Date.now();
  const id = await sha256Hex(token);
  await env.DB.prepare(`INSERT INTO sessions (id, user_id, client, created_at, expires_at) VALUES (?, ?, 'web', ?, ?)`)
    .bind(id, userId, now, now + 86400_000)
    .run();
  return { id, cookies: { session: token, csrf: bufToB64url(randomBytes(16)) } };
}

/** 瀏覽器端 push 金鑰（encryptPushPayload 要真的 P-256 公鑰才算得出密文） */
async function browserKeys(): Promise<{ p256dh: string; auth: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return { p256dh: bufToB64url(await exportRawKey(pair.publicKey)), auth: bufToB64url(randomBytes(16)) };
}

/** 0049 之前留下的訂閱：沒有 session_id */
async function insertLegacySub(userId: string, endpoint: string, keys: { p256dh: string; auth: string }) {
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('psub'), userId, endpoint, keys.p256dh, keys.auth, Date.now())
    .run();
}

async function endpointsOf(userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint`)
    .bind(userId)
    .all<{ endpoint: string }>();
  return rows.results.map((r) => r.endpoint);
}

async function vapidEnv(): Promise<typeof env> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
  return {
    ...env,
    VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
    VAPID_PUBLIC_KEY: bufToB64url(await exportRawKey(pair.publicKey)),
  } as unknown as typeof env;
}

/** 收下推播請求的假 fetch，回傳實際被推的 endpoint 清單 */
function recordingFetch(): { urls: string[]; fetchImpl: typeof fetch } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(new Request(input, init).url);
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { urls, fetchImpl };
}

// F4 之後 /push/subscribe 只收真正的推播服務網域（isAllowedPushEndpoint），
// 故 fixture 用真實網域；三者的字典序維持 a < b < legacy（endpointsOf 依 endpoint 排序）。
const EP_A = 'https://fcm.googleapis.com/fcm/send/dev-a';
const EP_B = 'https://fcm.googleapis.com/fcm/send/dev-b';
const EP_LEGACY = 'https://fcm.googleapis.com/fcm/send/dev-legacy';

describe('F5：push 訂閱綁 session', () => {
  it('登出只撤本機那台；其他仍登入的裝置（含未綁 session 的舊列）照樣收到推播', async () => {
    const a = await seedUser(env, 'hon@miseroda.com');
    const b = await addSession(a.userId);
    const keys = await browserKeys();

    expect((await post('/push/subscribe', a.cookies, { endpoint: EP_A, ...keys })).status).toBe(200);
    expect((await post('/push/subscribe', b.cookies, { endpoint: EP_B, ...keys })).status).toBe(200);
    await insertLegacySub(a.userId, EP_LEGACY, keys);

    expect((await post('/auth/logout', a.cookies, {})).status).toBe(200);
    // A 那列（綁 A session）被刪；B 與舊列都還在
    expect(await endpointsOf(a.userId)).toEqual([EP_B, EP_LEGACY]);

    const { urls, fetchImpl } = recordingFetch();
    const r = await pushToUser(await vapidEnv(), a.userId, { title: '寄件者', body: '主旨', url: '/' }, fetchImpl);
    expect(r.sent).toBe(2);
    expect(urls.sort()).toEqual([EP_B, EP_LEGACY]);
  });

  it('撤銷單一 session：只刪那台的訂閱，其他裝置與舊列不受影響', async () => {
    const a = await seedUser(env, 'hon2@miseroda.com');
    const b = await addSession(a.userId);
    const keys = await browserKeys();
    await post('/push/subscribe', a.cookies, { endpoint: EP_A, ...keys });
    await post('/push/subscribe', b.cookies, { endpoint: EP_B, ...keys });
    await insertLegacySub(a.userId, EP_LEGACY, keys);

    expect((await post(`/auth/sessions/${b.id}/revoke`, a.cookies, {})).status).toBe(200);
    expect(await endpointsOf(a.userId)).toEqual([EP_A, EP_LEGACY]);
  });

  it('撤銷全部 session：所有訂閱都刪（含未綁 session 的舊列）', async () => {
    const a = await seedUser(env, 'hon3@miseroda.com');
    const keys = await browserKeys();
    await post('/push/subscribe', a.cookies, { endpoint: EP_A, ...keys });
    await insertLegacySub(a.userId, EP_LEGACY, keys);

    expect((await post('/auth/sessions/revoke-all', a.cookies, {})).status).toBe(200);
    expect(await endpointsOf(a.userId)).toEqual([]);
  });

  it('綁定的 session 一旦失效，即使訂閱列還在也不再推送（送出前再擋一層）', async () => {
    const a = await seedUser(env, 'hon4@miseroda.com');
    const keys = await browserKeys();
    await post('/push/subscribe', a.cookies, { endpoint: EP_A, ...keys });
    // 模擬「session 已被撤銷、但訂閱列還沒被刪」（例如舊資料或其他撤銷路徑）
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ?`).bind(Date.now(), a.userId).run();

    const { urls, fetchImpl } = recordingFetch();
    const r = await pushToUser(await vapidEnv(), a.userId, { title: '寄件者', body: '主旨', url: '/' }, fetchImpl);
    expect(r).toEqual({ sent: 0, removed: 0 });
    expect(urls).toEqual([]);
  });
});
