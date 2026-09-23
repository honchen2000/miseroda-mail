import { newId } from './ids';

export interface AuditEntry {
  userId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
}

/** `db` 收 D1Database（背景任務）或 D1DatabaseSession（請求路徑的 `c.var.db`）——兩者都有 prepare()。 */
export async function audit(db: D1Database | D1DatabaseSession, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, user_id, action, target_type, target_id, ip, user_agent, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('aud'),
      entry.userId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.meta ? JSON.stringify(entry.meta) : null,
      Date.now(),
    )
    .run();
}
