import { hashCode, randomCode } from '../lib/crypto';
import { newId } from '../lib/ids';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export interface InviteRow {
  id: string;
  code_hash: string;
  email: string;
  role: 'admin' | 'user';
  invited_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

/** 建立邀請；回傳的明碼只出現這一次（DB 僅存雜湊） */
export async function createInvite(
  env: Env,
  args: { email: string; role: 'admin' | 'user'; invitedBy: string | null },
): Promise<{ id: string; code: string; expiresAt: number }> {
  const code = randomCode(3, 4); // 形如 PGNX-AU7R-0RA1，~60 bit 熵
  const id = newId('inv');
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO invites (id, code_hash, email, role, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, await hashCode(code), args.email.toLowerCase(), args.role, args.invitedBy, now, expiresAt)
    .run();
  return { id, code, expiresAt };
}

export async function findValidInvite(env: Env, code: string): Promise<InviteRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM invites WHERE code_hash = ?`)
    .bind(await hashCode(code))
    .first<InviteRow>();
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  return row;
}

export async function markInviteUsed(env: Env, id: string): Promise<boolean> {
  // 原子標記：併發重放時只有一個成功
  const res = await env.DB.prepare(`UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL`)
    .bind(Date.now(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}
