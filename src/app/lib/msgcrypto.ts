// F7.7：訊息級加密（瀏覽器端）。AES-GCM；金鑰 = SHA-256(PBKDF2(password,salt) ‖ fragmentSecret)。
// 站方只收到 密文/salt/iv（無 password、無 fragmentSecret）→ 無法解密、不存明文。
// ⚠️ 解密在公開頁 /e/<token> 的 inline JS（src/worker/encrypted.ts），派生邏輯「必須與此處逐位元一致」。
const PBKDF2_ITERS = 600_000; // NIST SP 800-132（2023）建議 ≥600k；解密頁 DECRYPT_JS 須同步
const enc = new TextEncoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deriveKey(password: string, salt: Uint8Array, fragmentSecret: Uint8Array): Promise<CryptoKey> {
  const pwKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const pwBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    pwKey,
    256,
  );
  // 密碼派生位元 ‖ fragmentSecret → SHA-256 → AES 金鑰（兩者缺一不可解）
  const combined = new Uint8Array(32 + fragmentSecret.length);
  combined.set(new Uint8Array(pwBits), 0);
  combined.set(fragmentSecret, 32);
  const keyBits = await crypto.subtle.digest('SHA-256', combined);
  return crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface EncryptedBundle {
  ciphertext: string; // base64（含 GCM tag）
  salt: string; // base64
  iv: string; // base64
  fragmentSecret: string; // base64url：放 URL fragment（#k=），永不送伺服器
}

/** 加密明文 → 可送伺服器存的 bundle（fragmentSecret 留在 client 組進連結 fragment）。 */
export async function encryptMessage(plaintext: string, password: string): Promise<EncryptedBundle> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const fragmentSecret = crypto.getRandomValues(new Uint8Array(32));
  const key = await deriveKey(password, salt, fragmentSecret);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return { ciphertext: b64(ct), salt: b64(salt), iv: b64(iv), fragmentSecret: b64url(fragmentSecret) };
}
