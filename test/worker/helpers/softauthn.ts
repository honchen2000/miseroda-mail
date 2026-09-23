// 測試用軟體 WebAuthn 認證器：產生真實可驗證的註冊/登入 response，
// 讓 @simplewebauthn/server 在 workerd 內走完整密碼學驗證（不 mock）。
import { bufToB64url } from '../../../src/worker/lib/crypto';

/* ---------- 迷你 CBOR 編碼器（attestationObject / COSE key 夠用） ---------- */

type CborValue = number | string | Uint8Array | CborMap;
type CborMap = Map<number | string, CborValue>;

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  throw new Error('cbor: length too large for tests');
}

function cborEncode(value: CborValue): number[] {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('cbor: int only');
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);
  }
  if (typeof value === 'string') {
    const utf8 = [...new TextEncoder().encode(value)];
    return [...cborHead(3, utf8.length), ...utf8];
  }
  if (value instanceof Uint8Array) {
    return [...cborHead(2, value.length), ...value];
  }
  // Map
  const out = cborHead(5, value.size);
  for (const [k, v] of value) {
    out.push(...cborEncode(k as CborValue), ...cborEncode(v));
  }
  return out;
}

/* ---------- DER ECDSA 簽章（WebCrypto raw r||s → DER SEQUENCE） ---------- */

function derInt(bytes: Uint8Array): number[] {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let body = [...bytes.slice(i)];
  if (body[0] & 0x80) body = [0, ...body];
  return [0x02, body.length, ...body];
}

function rawSigToDer(raw: Uint8Array): Uint8Array {
  const r = derInt(raw.slice(0, 32));
  const s = derInt(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

/* ---------- 軟體認證器 ---------- */

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

export interface SoftAuthenticator {
  credentialIdB64url: string;
  register(options: { challenge: string }, origin: string, rpId: string): Promise<unknown>;
  authenticate(options: { challenge: string }, origin: string, rpId: string): Promise<unknown>;
}

export async function createAuthenticator(): Promise<SoftAuthenticator> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const credentialIdB64url = bufToB64url(credentialId);
  let counter = 0;

  async function cosePublicKey(): Promise<Uint8Array> {
    const raw = new Uint8Array((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer);
    const x = raw.slice(1, 33);
    const y = raw.slice(33, 65);
    const cose: CborMap = new Map<number, CborValue>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, x],
      [-3, y],
    ]);
    return new Uint8Array(cborEncode(cose));
  }

  function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  function counterBytes(): number[] {
    return [(counter >> 24) & 0xff, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff];
  }

  return {
    credentialIdB64url,

    async register(options, origin, rpId) {
      const rpIdHash = await sha256(new TextEncoder().encode(rpId));
      const cose = await cosePublicKey();
      const flags = 0x45; // UP | UV | AT
      const authData = new Uint8Array([
        ...rpIdHash,
        flags,
        ...counterBytes(),
        ...new Uint8Array(16), // AAGUID
        (credentialId.length >> 8) & 0xff,
        credentialId.length & 0xff,
        ...credentialId,
        ...cose,
      ]);
      const attObj: CborMap = new Map<string, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]);
      const cdj = clientData('webauthn.create', options.challenge, origin);
      return {
        id: credentialIdB64url,
        rawId: credentialIdB64url,
        type: 'public-key',
        response: {
          clientDataJSON: bufToB64url(cdj),
          attestationObject: bufToB64url(new Uint8Array(cborEncode(attObj))),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },

    async authenticate(options, origin, rpId) {
      counter += 1;
      const rpIdHash = await sha256(new TextEncoder().encode(rpId));
      const flags = 0x05; // UP | UV
      const authData = new Uint8Array([...rpIdHash, flags, ...counterBytes()]);
      const cdj = clientData('webauthn.get', options.challenge, origin);
      const cdjHash = await sha256(cdj);
      const signBase = new Uint8Array([...authData, ...cdjHash]);
      const rawSig = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signBase as BufferSource),
      );
      return {
        id: credentialIdB64url,
        rawId: credentialIdB64url,
        type: 'public-key',
        response: {
          clientDataJSON: bufToB64url(cdj),
          authenticatorData: bufToB64url(authData),
          signature: bufToB64url(rawSigToDer(rawSig)),
          userHandle: null,
        },
        clientExtensionResults: {},
      };
    },
  };
}
