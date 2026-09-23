// passkey 救援 token：admin 對既有使用者核發一次性、限期的「重新綁定 passkey」憑證。
// 仿 invites（雜湊存放 + 單次 + 限期），但綁的是既有 user_id（不建立新使用者）。
import { randomToken, sha256Hex } from '../lib/crypto';
import { newId } from '../lib/ids';

export const RECOVERY_TTL_MS = 2 * 60 * 60 * 1000; // 2 小時

export interface RecoveryRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

/** 建立救援 token；回傳的明碼只出現這一次（DB 僅存雜湊）。 */
export async function createRecoveryToken(
  env: Env,
  args: { userId: string; createdBy: string | null },
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(); // 256-bit
  const now = Date.now();
  const expiresAt = now + RECOVERY_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO recovery_tokens (id, user_id, token_hash, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('rec'), args.userId, await sha256Hex(token), args.createdBy, now, expiresAt)
    .run();
  return { token, expiresAt };
}

/** 以明碼查有效 token（未過期、未用）。 */
export async function findValidRecoveryToken(env: Env, token: string): Promise<RecoveryRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM recovery_tokens WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .first<RecoveryRow>();
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  return row;
}

/** 原子標記為已用：併發重放只有一個成功。 */
export async function markRecoveryUsed(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(`UPDATE recovery_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`)
    .bind(Date.now(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}
