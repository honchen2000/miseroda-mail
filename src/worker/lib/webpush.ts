// Web Push：RFC 8291 aes128gcm 加密 + RFC 8292 VAPID（純 WebCrypto，零依賴）
// 加密實作以 RFC 8291 附錄 A 官方測試向量逐位元驗證（見 webpush.test.ts）
import { isPublicHttpsUrl } from '../email/list-unsubscribe';
import { b64ToBytes, bufToB64url } from './crypto';

const te = new TextEncoder();

/** workers-types 把 ECDH 的 `public` 欄位改名 `$public`，runtime 實際吃 `public` —— 統一在這裡 cast */
export function ecdhParams(pub: CryptoKey) {
  return { name: 'ECDH', public: pub } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
}

/** exportKey('raw') 在 workers-types 回傳 union —— 收斂成 Uint8Array */
export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
}

async function hkdfExtractExpand(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** P-256 raw 公鑰 (65B) → JWK */
function rawPubToJwk(raw: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: bufToB64url(raw.slice(1, 33)),
    y: bufToB64url(raw.slice(33, 65)),
  };
}

export interface EphemeralOverride {
  /** 測試用：固定 app server 私鑰（JWK d）與 salt 以重現 RFC 向量 */
  asPrivateD: string;
  asPublicRaw: string; // base64url 65B
  salt: string; // base64url 16B
}

/**
 * RFC 8291 aes128gcm 加密（單一 record）
 * @returns 完整 push body：salt(16) | rs(4) | idlen(1) | as_public(65) | ciphertext
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  uaPublicB64url: string,
  authSecretB64url: string,
  override?: EphemeralOverride,
): Promise<Uint8Array> {
  const uaPublic = b64ToBytes(uaPublicB64url);
  const authSecret = b64ToBytes(authSecretB64url);

  // App server 臨時金鑰（測試時可注入固定值）
  let asPrivateKey: CryptoKey;
  let asPublicRaw: Uint8Array;
  if (override) {
    const pubJwk = rawPubToJwk(b64ToBytes(override.asPublicRaw));
    asPrivateKey = await crypto.subtle.importKey(
      'jwk',
      { ...pubJwk, d: override.asPrivateD },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    asPublicRaw = b64ToBytes(override.asPublicRaw);
  } else {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    asPrivateKey = kp.privateKey;
    asPublicRaw = await exportRawKey(kp.publicKey);
  }
  const salt = override
    ? b64ToBytes(override.salt)
    : crypto.getRandomValues(new Uint8Array(16));

  // ECDH 共享密鑰
  const uaKey = await crypto.subtle.importKey(
    'jwk',
    rawPubToJwk(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams(uaKey), asPrivateKey, 256));

  // HKDF 鏈（RFC 8291 §3.3–3.4）
  const keyInfo = concat(te.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublicRaw);
  const ikm = await hkdfExtractExpand(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdfExtractExpand(salt, ikm, concat(te.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdfExtractExpand(salt, ikm, concat(te.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // AES-128-GCM：明文 + 0x02 結尾分隔符（最後一筆 record）
  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, padded as BufferSource),
  );

  // aes128gcm header：salt | rs=4096 | idlen=65 | keyid=as_public
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  const header = concat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concat(header, ciphertext);
}

/** RFC 8292 VAPID：ES256 JWT + Authorization 標頭 */
export async function vapidAuthHeader(
  endpoint: string,
  publicKeyB64url: string,
  privateJwkJson: string,
  subject: string,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = bufToB64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bufToB64url(
    te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  );
  const signingInput = `${header}.${payload}`;
  const jwk = JSON.parse(privateJwkJson) as JsonWebKey;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signingInput)),
  );
  return `vapid t=${signingInput}.${bufToB64url(sig)}, k=${publicKeyB64url}`;
}

/** 瀏覽器推播服務主機（精確比對）。 */
const PUSH_ENDPOINT_HOSTS: readonly string[] = [
  'fcm.googleapis.com', // Chrome / Chromium 系（含 Brave、Edge 走 FCM 時）
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari（macOS / iOS）
];

/** 同上，但推播服務會分區到子網域（尾綴比對；皆為服務商自有網域）。 */
const PUSH_ENDPOINT_SUFFIXES: readonly string[] = [
  '.push.services.mozilla.com', // Firefox autopush 節點
  '.push.apple.com', // Safari
  '.notify.windows.com', // Edge（WNS，形如 wns2-xxx.notify.windows.com）
];

/**
 * endpoint 是否為可安全推送的瀏覽器推播服務位址。
 *
 * SSRF 防護：endpoint 由瀏覽器提供、但經使用者的請求原封不動存進 DB，若不設限，
 * Worker 就成了「任意 URL 的匿名 POST 代理」（還會帶上一份有效的 VAPID 斷言）。
 * 因此除了沿用 isPublicHttpsUrl（https + 擋 localhost/內網/裸 IP）外，
 * 再收斂到四大瀏覽器真正在用的推播服務網域。
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (!isPublicHttpsUrl(endpoint)) return false;
  // FQDN 尾點同 isPublicHttpsUrl 先削掉，避免 `fcm.googleapis.com.` 之類寫法比對不到。
  const host = new URL(endpoint).hostname.toLowerCase().replace(/\.+$/, '');
  return PUSH_ENDPOINT_HOSTS.includes(host) || PUSH_ENDPOINT_SUFFIXES.some((s) => host.endsWith(s));
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** 目前收件匣未讀數 → SW 在背景設 OS 圖示角標（setAppBadge）。省略則不動角標。 */
  unread?: number;
  /** 訊息 id → SW 用作通知 tag（不同信並列、不互相覆蓋）＋通知動作鈕（封存/已讀）的目標。 */
  id?: string;
}

/**
 * 推播給使用者的所有訂閱裝置；404/410 自動清除失效訂閱。
 * @param fetchImpl 測試注入用
 */
export async function pushToUser(
  env: Env,
  userId: string,
  payload: PushPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; removed: number }> {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return { sent: 0, removed: 0 };
  // F5：綁了 session 的訂閱（migration 0049 之後建立的）只在該 session 仍有效時才推——
  // 推播內容含寄件者＋主旨，登出／撤銷後那台裝置不該再收到。sweep 會把撤銷/過期的 sessions 列刪掉，
  // 屆時 EXISTS 查不到 → 一樣不推（fail closed）。
  // session_id IS NULL 是 0049 之前留下的舊訂閱：仍放行，避免升級當下讓仍登入中的裝置無聲斷掉通知；
  // 它們會在下次開 App 的重新回報時補上綁定，或在登出／撤銷全部 session／停用帳號時被刪除。
  const subs = await env.DB.prepare(
    `SELECT * FROM push_subscriptions p
      WHERE p.user_id = ?
        AND (p.session_id IS NULL
             OR EXISTS (SELECT 1 FROM sessions s
                         WHERE s.id = p.session_id AND s.revoked_at IS NULL AND s.expires_at > ?))`,
  )
    .bind(userId, Date.now())
    .all<PushSubscriptionRow>();
  if (!subs.results.length) return { sent: 0, removed: 0 };

  const plaintext = te.encode(JSON.stringify(payload));
  let sent = 0;
  let removed = 0;
  for (const sub of subs.results) {
    // 送出前重驗（訂閱時已擋，但既有資料列可能早於該檢查）——不刪列，單純跳過。
    if (!isAllowedPushEndpoint(sub.endpoint)) {
      console.error('push endpoint blocked', sub.endpoint.slice(0, 40));
      continue;
    }
    try {
      const body = await encryptPushPayload(plaintext, sub.p256dh, sub.auth);
      const auth = await vapidAuthHeader(sub.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_JWK, 'mailto:hon_chen@miseroda.com');
      const res = await fetchImpl(sub.endpoint, {
        method: 'POST',
        // 推播服務不會轉址；不跟隨可避免 3xx 把這個 POST（含 VAPID 斷言）帶去別的主機。
        redirect: 'manual',
        headers: {
          Authorization: auth,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: 'normal',
        },
        body: body as BodyInit,
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(sub.id).run();
        removed += 1;
      } else if (res.ok || res.status === 201) {
        sent += 1;
        await env.DB.prepare(`UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?`)
          .bind(Date.now(), sub.id)
          .run();
      }
    } catch (err) {
      console.error('push failed', sub.endpoint.slice(0, 40), err);
    }
  }
  return { sent, removed };
}
