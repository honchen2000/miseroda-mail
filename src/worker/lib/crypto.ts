// WebCrypto 工具集 —— 全系統不使用 PBKDF2（workerd 上限 100k 次迭代，
// 且本系統無密碼：高熵隨機碼 + SHA-256 即足夠）

const te = new TextEncoder();

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function bufToB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 隨機 session/bearer token（base64url, 256-bit） */
export function randomToken(): string {
  return bufToB64url(randomBytes(32));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? te.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常數時間字串比較（兩者皆為已知格式時使用） */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = te.encode(a);
  const bb = te.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/* ---- AES-GCM（TOTP secret 加密用，金鑰來自 wrangler secret） ---- */

async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64);
  if (raw.length !== 32) throw new Error('TOTP_ENC_KEY must be 32 bytes base64');
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function aesGcmEncrypt(keyB64: string, plaintext: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, te.encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return bytesToB64(out);
}

export async function aesGcmDecrypt(keyB64: string, payloadB64: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const payload = b64ToBytes(payloadB64);
  const iv = payload.slice(0, 12);
  const ct = payload.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}

/* ---- Base32（RFC 4648，無 padding，TOTP secret 用） ---- */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Uint8Array {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/* ---- 人類可讀的高熵碼（邀請碼 / 備援碼）---- */

// 排除易混淆字元 0/O/1/I/L
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function randomCode(groups: number, groupLen: number, sep = '-'): string {
  const bytes = randomBytes(groups * groupLen);
  const chars: string[] = [];
  for (let i = 0; i < groups * groupLen; i++) {
    chars.push(CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]);
  }
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    parts.push(chars.slice(g * groupLen, (g + 1) * groupLen).join(''));
  }
  return parts.join(sep);
}

/** 正規化使用者輸入的碼（去空白/分隔，轉大寫）後雜湊 */
export async function hashCode(code: string): Promise<string> {
  return sha256Hex(code.toUpperCase().replace(/[^A-Z0-9]/gi, ''));
}
