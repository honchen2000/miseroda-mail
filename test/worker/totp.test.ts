import { describe, expect, it } from 'vitest';
import { totpCode, verifyTotp, generateTotpSecret, otpauthUri } from '../../src/worker/auth/totp';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base32Decode,
  base32Encode,
  hashCode,
  randomCode,
} from '../../src/worker/lib/crypto';

// RFC 6238 附錄 B 測試向量（SHA-1，secret = ASCII "12345678901234567890"）
// 8 碼向量取後 6 碼即為 6 碼 TOTP（同一動態截斷值 mod 10^6）
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP (RFC 6238)', () => {
  it('matches RFC test vectors', async () => {
    expect(await totpCode(RFC_SECRET_B32, 59 * 1000)).toBe('287082'); // 94287082
    expect(await totpCode(RFC_SECRET_B32, 1111111109 * 1000)).toBe('081804'); // 07081804
    expect(await totpCode(RFC_SECRET_B32, 1234567890 * 1000)).toBe('005924'); // 89005924
    expect(await totpCode(RFC_SECRET_B32, 2000000000 * 1000)).toBe('279037'); // 69279037
  });

  it('accepts ±1 step window, rejects outside', async () => {
    const t = 1234567890 * 1000;
    const prev = await totpCode(RFC_SECRET_B32, t, -1);
    const next = await totpCode(RFC_SECRET_B32, t, +1);
    const far = await totpCode(RFC_SECRET_B32, t, +2);
    expect(await verifyTotp(RFC_SECRET_B32, prev, t)).toBe(true);
    expect(await verifyTotp(RFC_SECRET_B32, next, t)).toBe(true);
    expect(await verifyTotp(RFC_SECRET_B32, far, t)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, '000000', t)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, 'abcdef', t)).toBe(false);
  });

  it('generates 20-byte base32 secrets and otpauth uri', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret).length).toBe(20);
    const uri = otpauthUri(secret, 'hon@miseroda.com');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(secret);
    expect(uri).toContain('issuer=Miseroda%20Mail');
  });
});

describe('crypto helpers', () => {
  it('base32 roundtrip', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 42]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('AES-GCM roundtrip and tamper rejection', async () => {
    const key = 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdCE=';
    const enc = await aesGcmEncrypt(key, 'secret-payload-中文');
    expect(await aesGcmDecrypt(key, enc)).toBe('secret-payload-中文');
    const tampered = enc.slice(0, -4) + 'AAAA';
    await expect(aesGcmDecrypt(key, tampered)).rejects.toThrow();
  });

  it('randomCode shape + hashCode normalization', async () => {
    const code = randomCode(3, 4);
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(await hashCode('ab-cd 12')).toBe(await hashCode('ABCD12'));
  });
});
