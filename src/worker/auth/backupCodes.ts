import { hashCode, randomCode } from '../lib/crypto';
import { newId } from '../lib/ids';

const BACKUP_CODE_COUNT = 8;

/** 重新產生 8 組備援碼（覆蓋舊的），明碼僅此一次回傳 */
export async function generateBackupCodes(env: Env, userId: string): Promise<string[]> {
  const codes: string[] = [];
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM backup_codes WHERE user_id = ?`).bind(userId),
  ];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = randomCode(2, 4).toLowerCase(); // 形如 k7mq-2hd8
    codes.push(code);
    stmts.push(
      env.DB.prepare(`INSERT INTO backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)`).bind(
        newId('bak'),
        userId,
        await hashCode(code),
      ),
    );
  }
  await env.DB.batch(stmts);
  return codes;
}

/** 驗證並消耗一組備援碼（單次有效） */
export async function consumeBackupCode(env: Env, userId: string, code: string): Promise<boolean> {
  const hash = await hashCode(code);
  const res = await env.DB.prepare(
    `UPDATE backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
  )
    .bind(Date.now(), userId, hash)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function remainingBackupCodes(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
