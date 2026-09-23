import { newId } from '../lib/ids';

/** 主旨正規化（Re:/Fwd:/回覆： 前綴去除）供新 thread 命名 */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd|fw|回覆|轉寄)\s*[:：]\s*)+/i, '').trim();
}

/**
 * References 鏈 threading：
 * 依 In-Reply-To / References 找同使用者既有訊息的 thread；找不到就開新 thread。
 * 回傳 threadId（呼叫端負責在插入訊息後更新 thread 統計）。
 */
export async function resolveThread(
  env: Env,
  userId: string,
  args: { inReplyTo?: string | null; references?: string | null; subject: string; timestamp: number },
): Promise<string> {
  const refs = new Set<string>();
  if (args.references) {
    for (const r of args.references.split(/\s+/)) {
      const id = r.trim();
      if (id) refs.add(id);
    }
  }
  if (args.inReplyTo) refs.add(args.inReplyTo.trim());

  if (refs.size > 0) {
    const list = [...refs].slice(0, 20);
    const placeholders = list.map(() => '?').join(',');
    const row = await env.DB.prepare(
      `SELECT thread_id FROM messages WHERE user_id = ? AND message_id_header IN (${placeholders})
       ORDER BY received_at DESC LIMIT 1`,
    )
      .bind(userId, ...list)
      .first<{ thread_id: string }>();
    if (row) return row.thread_id;
  }

  const threadId = newId('thr');
  await env.DB.prepare(
    `INSERT INTO threads (id, user_id, subject, last_message_at, message_count) VALUES (?, ?, ?, ?, 0)`,
  )
    .bind(threadId, userId, normalizeSubject(args.subject), args.timestamp)
    .run();
  return threadId;
}

/**
 * 插入訊息後更新 thread 統計。
 * 由 COUNT(*) 重算（而非 +1）→ 冪等：重寄/重試重跑同一封也不會重複計數（C3）。
 * 呼叫端須在訊息 INSERT 提交後才呼叫。
 */
export async function bumpThread(env: Env, threadId: string, timestamp: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE threads SET message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ?),
            last_message_at = MAX(last_message_at, ?) WHERE id = ?`,
  )
    .bind(threadId, timestamp, threadId)
    .run();
}
