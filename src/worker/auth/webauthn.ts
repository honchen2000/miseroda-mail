// @simplewebauthn/server 薄封裝：challenge 存 D1、RP ID 由環境決定
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { b64ToBytes, bytesToB64 } from '../lib/crypto';

export const RP_NAME = 'Miseroda Mail';

/** ORIGIN 支援逗號分隔清單（dev 同時允許 5173/8787） */
export function allowedOrigins(env: Env): string[] {
  return env.ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
}

/** passkey 名稱是綁定者自訂的字串——救援流程裡「綁定者」可能是任何拿到救援連結的人，
 *  而這個字串會出現在 admin 重設 TOTP 的安全確認畫面上。換行/控制字元/雙向文字覆寫符
 *  可被用來偽造成多行說明誤導 admin，故一律壓成單行空白後再存/再顯示。 */
export function sanitizePasskeyName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const clean = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ').trim().slice(0, 64);
  return clean || null;
}

export interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
}

export async function makeRegistrationOptions(env: Env, args: {
  userIdB64url: string;
  email: string;
  excludeCredentialIds: string[];
  /** 'platform' = 優先用本機驗證器（Windows Hello / Touch ID），避開 Google 密碼管理工具那條易卡的路 */
  authenticatorAttachment?: 'platform' | 'cross-platform';
}) {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: env.RP_ID,
    userID: b64ToBytes(args.userIdB64url),
    userName: args.email,
    userDisplayName: args.email,
    attestationType: 'none',
    excludeCredentials: args.excludeCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      ...(args.authenticatorAttachment ? { authenticatorAttachment: args.authenticatorAttachment } : {}),
    },
  });
}

export interface RegResult {
  credentialId: string;
  publicKeyB64: string;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
}

export async function checkRegistration(env: Env, args: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}): Promise<{ ok: true; data: RegResult } | { ok: false; reason: string }> {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      // 多接受 workers.dev 與本機，以及 ORIGIN 清單，降低跨裝置/同步 passkey 的 origin 邊角
      expectedOrigin: allowedOrigins(env),
      expectedRPID: env.RP_ID,
      requireUserVerification: false,
    });
  } catch (err) {
    // verifyRegistrationResponse 對 origin/RPID/簽章/格式不符會 throw（WebAuthnError）
    const reason = err instanceof Error ? err.message : String(err);
    console.error('webauthn register verify threw', { reason, rpId: env.RP_ID, origins: allowedOrigins(env) });
    return { ok: false, reason };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: 'not_verified' };
  }
  const info = verification.registrationInfo;
  return {
    ok: true,
    data: {
      credentialId: info.credential.id,
      publicKeyB64: bytesToB64(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    },
  };
}

export async function makeAuthenticationOptions(env: Env, allowCredentialIds: string[]) {
  return generateAuthenticationOptions({
    rpID: env.RP_ID,
    userVerification: 'preferred',
    allowCredentials: allowCredentialIds.map((id) => ({ id })),
  });
}

export async function checkAuthentication(env: Env, args: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credential: CredentialRow;
}) {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: allowedOrigins(env),
      expectedRPID: env.RP_ID,
      requireUserVerification: false,
      credential: {
        id: args.credential.id,
        publicKey: b64ToBytes(args.credential.public_key),
        counter: args.credential.counter,
        transports: (args.credential.transports ? JSON.parse(args.credential.transports) : []) as never,
      },
    });
  } catch (err) {
    console.error('webauthn auth verify threw', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!verification.verified) return null;
  return { newCounter: verification.authenticationInfo.newCounter };
}
