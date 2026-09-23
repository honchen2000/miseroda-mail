// Phase-2：Web Push（RFC 8291/8292）+ Durable Object 即時收件
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { b64ToBytes, bufToB64url } from '../../src/worker/lib/crypto';
import { ecdhParams, encryptPushPayload, exportRawKey, pushToUser, vapidAuthHeader } from '../../src/worker/lib/webpush';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

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
  const ctx = createExecutionContext();
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    ctx,
  );
}

/* ================= RFC 8291 加密 ================= */

describe('RFC 8291 aes128gcm', () => {
  it('附錄 A 官方測試向量逐位元相符', async () => {
    const plaintext = b64ToBytes('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24');
    const body = await encryptPushPayload(
      plaintext,
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', // ua_public
      'BTBZMqHH6r4Tts7J_aSIgg', // auth_secret
      {
        asPrivateD: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
        asPublicRaw: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
        salt: 'DGv6ra1nlYgDCS1FRnbzlw',
      },
    );
    expect(bufToB64url(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('隨機臨時金鑰下，瀏覽器端可解密回原文（往返驗證）', async () => {
    // 模擬瀏覽器：產生 UA 金鑰對 + auth secret
    const uaPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const uaPubRaw = await exportRawKey(uaPair.publicKey);
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const payload = new TextEncoder().encode(JSON.stringify({ title: '新郵件', body: '哈囉 🐧' }));

    const body = await encryptPushPayload(payload, bufToB64url(uaPubRaw), bufToB64url(authSecret));

    // 解析 header
    const salt = body.slice(0, 16);
    const idlen = body[20];
    expect(idlen).toBe(65);
    const asPub = body.slice(21, 21 + 65);
    const ct = body.slice(21 + 65);

    // 瀏覽器側 HKDF 鏈解密
    const asKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: bufToB64url(asPub.slice(1, 33)), y: bufToB64url(asPub.slice(33, 65)) },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams(asKey), uaPair.privateKey, 256));
    const te = new TextEncoder();
    const hkdf = async (saltB: Uint8Array, ikmB: Uint8Array, info: Uint8Array, len: number) => {
      const k = await crypto.subtle.importKey('raw', ikmB as BufferSource, 'HKDF', false, ['deriveBits']);
      return new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: saltB as BufferSource, info: info as BufferSource }, k, len * 8),
      );
    };
    const cat = (...ps: Uint8Array[]) => {
      const out = new Uint8Array(ps.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of ps) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    };
    const ikm = await hkdf(authSecret, ecdh, cat(te.encode('WebPush: info'), new Uint8Array([0]), uaPubRaw, asPub), 32);
    const cek = await hkdf(salt, ikm, cat(te.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
    const nonce = await hkdf(salt, ikm, cat(te.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
    const aes = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt']);
    const padded = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aes, ct as BufferSource),
    );
    expect(padded[padded.length - 1]).toBe(2); // 末筆 record 分隔符
    expect(new TextDecoder().decode(padded.slice(0, -1))).toBe(JSON.stringify({ title: '新郵件', body: '哈囉 🐧' }));
  });

  it('VAPID 標頭：JWT 可用公鑰驗章，aud/sub/exp 正確', async () => {
    // 臨時 VAPID 金鑰對（測試不用正式私鑰）
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const privJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
    const pubRaw = bufToB64url(await exportRawKey(pair.publicKey));

    const header = await vapidAuthHeader(
      'https://fcm.googleapis.com/fcm/send/abc123',
      pubRaw,
      privJwk,
      'mailto:hon_chen@miseroda.com',
    );
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).toBeTruthy();
    expect(m![2]).toBe(pubRaw);

    const [h, p, s] = m![1].split('.');
    const claims = JSON.parse(new TextDecoder().decode(b64ToBytes(p))) as { aud: string; sub: string; exp: number };
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:hon_chen@miseroda.com');
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 3600); // RFC 上限 24h

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      b64ToBytes(s) as BufferSource,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});

/* ================= 訂閱 API + 推送管線 ================= */

describe('push 訂閱 + pushToUser', () => {
  it('訂閱 CRUD、加密推送、410 自動清除', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');

    // 訂閱（瀏覽器側金鑰）
    const uaPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const p256dh = bufToB64url(await exportRawKey(uaPair.publicKey));
    const auth = bufToB64url(crypto.getRandomValues(new Uint8Array(16)));
    const subRes = await apiCall('/push/subscribe', hon.cookies, {
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh, auth },
    });
    expect(subRes.status).toBe(200);

    // 同 endpoint 重訂閱 → upsert 不報錯
    expect(
      (await apiCall('/push/subscribe', hon.cookies, {
        body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh, auth },
      })).status,
    ).toBe(200);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>();
    expect(count?.n).toBe(1);

    // 測試用 VAPID 金鑰注入 env
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
    ])) as CryptoKeyPair;
    const testEnv = {
      ...env,
      VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
      VAPID_PUBLIC_KEY: bufToB64url(await exportRawKey(pair.publicKey)),
    } as unknown as typeof env;

    // 推送：fake fetch 收下請求並驗格式
    const seen: { url: string; headers: Headers; bodyLen: number }[] = [];
    const okFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({
        url: req.url,
        headers: req.headers,
        bodyLen: new Uint8Array(await req.arrayBuffer()).length,
      });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const r1 = await pushToUser(testEnv, hon.userId, { title: '新郵件', body: '主旨', url: '/' }, okFetch);
    expect(r1).toEqual({ sent: 1, removed: 0 });
    expect(seen[0].url).toBe('https://fcm.googleapis.com/fcm/send/abc');
    expect(seen[0].headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(seen[0].headers.get('Authorization')).toMatch(/^vapid t=.+, k=.+$/);
    expect(seen[0].headers.get('TTL')).toBe('86400');
    // body = header(16+4+1+65) + 密文(明文+pad1+tag16)
    const ptLen = new TextEncoder().encode(JSON.stringify({ title: '新郵件', body: '主旨', url: '/' })).length;
    expect(seen[0].bodyLen).toBe(86 + ptLen + 17);

    // 410 Gone → 訂閱自動刪除
    const goneFetch = (async () => new Response(null, { status: 410 })) as typeof fetch;
    const r2 = await pushToUser(testEnv, hon.userId, { title: 'x', body: 'y', url: '/' }, goneFetch);
    expect(r2).toEqual({ sent: 0, removed: 1 });
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>();
    expect(after?.n).toBe(0);

    // 取消訂閱 API（已刪也冪等）
    expect(
      (await apiCall('/push/unsubscribe', hon.cookies, { body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' } }))
        .status,
    ).toBe(200);

    // VAPID 未設定 → 安靜跳過
    const bare = { ...env, VAPID_PRIVATE_JWK: '', VAPID_PUBLIC_KEY: '' } as unknown as typeof env;
    expect(await pushToUser(bare, hon.userId, { title: 'x', body: 'y', url: '/' }, okFetch)).toEqual({
      sent: 0,
      removed: 0,
    });
  });

  it('SSRF：非推播服務網域的 endpoint 訂閱被擋，既存資料列也不會被推送', async () => {
    const hon = await seedUser(env, 'ssrf@miseroda.com', 'admin');

    // 訂閱時：任意 https URL / 內網 / http 一律 400，且不寫進資料庫
    for (const endpoint of [
      'https://attacker.example.com/collect',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://127.0.0.1/internal',
      'https://fcm.googleapis.com.attacker.example/fcm/send/abc',
    ]) {
      expect((await apiCall('/push/subscribe', hon.cookies, { body: { endpoint, p256dh: 'k', auth: 'a' } })).status).toBe(400);
    }
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>();
    expect(n?.n).toBe(0);

    // 送出時：早於此檢查存在的資料列也不得送出（不 fetch、也不刪列）
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind('psub_legacy', hon.userId, 'https://attacker.example.com/collect', 'k', 'a', Date.now())
      .run();
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    const testEnv = {
      ...env,
      VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
      VAPID_PUBLIC_KEY: bufToB64url(await exportRawKey(pair.publicKey)),
    } as unknown as typeof env;
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    expect(await pushToUser(testEnv, hon.userId, { title: 'x', body: 'y', url: '/' }, countingFetch)).toEqual({
      sent: 0,
      removed: 0,
    });
    expect(calls).toBe(0);
    const kept = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });
});

// Durable Object WebSocket 測試在 test/realtime/（isolated storage 限制，獨立 project）
