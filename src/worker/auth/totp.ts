// RFC 6238 TOTP（SHA-1 / 6 碼 / 30 秒，±1 step 容忍）
import { base32Decode, base32Encode, randomBytes, timingSafeEqualStr } from '../lib/crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

async function hotp(secretB32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secretB32) as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  // counter 不會超過 2^53，高 32 位用整除取得
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export async function totpCode(secretB32: string, timeMs: number, stepOffset = 0): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS) + stepOffset;
  return hotp(secretB32, counter);
}

export async function verifyTotp(secretB32: string, code: string, timeMs = Date.now()): Promise<boolean> {
  const input = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(input)) return false;
  for (const offset of [0, -1, 1]) {
    if (timingSafeEqualStr(await totpCode(secretB32, timeMs, offset), input)) return true;
  }
  return false;
}

export function otpauthUri(secretB32: string, accountEmail: string): string {
  const issuer = encodeURIComponent('Miseroda Mail');
  const account = encodeURIComponent(accountEmail);
  return `otpauth://totp/${issuer}:${account}?secret=${secretB32}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
