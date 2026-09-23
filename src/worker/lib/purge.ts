// F9.1：單信永久刪除（認領 → DB 交易刪列 → 收尾清 R2/FTS），供 sweep 自動清與保留規則（F9.2）重用。
// 「絕不誤刪」設計：
//   ① 逐信原子認領（CAS 重驗 folder 仍在 spam/trash 且仍過期），把 folder_changed_at 設為 NULL 哨兵——
//      NULL 列 sweep 永不選中（兼防重疊 cron 重複認領）；若使用者此刻把信救回，UPDATE folder 的
//      trigger 會把哨兵重置為 now → 下方所有帶哨兵 guard 的刪除整組落空，等於自動放棄。
//   ② children＋本列在同一個 batch（=transaction）內刪，每條都帶哨兵 guard → 全刪或全不刪，
//      被救回的信連標籤/附件列都毫髮無傷。
//   ③ 只有列真的刪掉才清 R2/FTS（冪等；中斷殘留僅占空間且不可達，絕不反向）。
//   認領後 crash 的信會停在 NULL → 永不自動清（往「留著」的安全方向失敗）。
import { r2CalKey, r2HtmlKey, r2RawKey } from './keys';

export interface PurgeTarget {
  id: string;
  user_id: string;
}

export interface PurgeOptions {
  /** 認領與刪除時信必須仍在這些資料夾（白名單驗證後才內插 SQL）。預設 F9.1 的 spam/trash。 */
  folders?: readonly string[];
  /** F9.2：保留規則的豁免訊號——星標/釘選/稍後處理中/工作流狀態/待跟進/匯入史永不清。
   *  認領與交易 guard 都重驗（豁免在 SELECT 之後才加上的訊號，如剛加的星標）。 */
  exemptUserSignals?: boolean;
  /** F9.2 電子報：只清已讀（未讀＝可能還沒看到的重要通知，不可逆刪除太危險）。 */
  requireRead?: boolean;
}

const PURGEABLE_FOLDERS = new Set(['spam', 'trash', 'archive', 'inbox']);

// 對 messages 本列生效（claim UPDATE / 最終 DELETE 直接引用；guard 的 EXISTS 子查詢內同名可用）
const USER_SIGNAL_EXEMPT_SQL = `AND is_starred = 0 AND pinned_at IS NULL AND snoozed_until IS NULL
  AND message_status IS NULL AND import_job_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.message_id = messages.id AND f.status = 'pending')`;

export async function purgeMessages(
  env: Env,
  targets: PurgeTarget[],
  cutoff: number,
  options: PurgeOptions = {},
): Promise<number> {
  const folders = options.folders ?? ['spam', 'trash'];
  if (!folders.length || folders.some((f) => !PURGEABLE_FOLDERS.has(f))) {
    throw new Error(`purgeMessages: invalid folders ${folders.join(',')}`);
  }
  const folderSql = folders.map((f) => `'${f}'`).join(', '); // 白名單常數，非用戶輸入
  const exempt = `${options.exemptUserSignals ? USER_SIGNAL_EXEMPT_SQL : ''} ${options.requireRead ? 'AND is_read = 1' : ''}`;

  let purged = 0;
  for (const m of targets) {
    const claim = await env.DB.prepare(
      `UPDATE messages SET folder_changed_at = NULL
       WHERE id = ? AND folder IN (${folderSql}) AND folder_changed_at IS NOT NULL AND folder_changed_at < ? ${exempt}`,
    )
      .bind(m.id, cutoff)
      .run();
    if (claim.meta.changes !== 1) continue; // 已被救回 / 已加星釘選 / 已被別的 cron 認領 → 不動

    // R2 keys 先蒐集（刪列後查不到）；F3 起附件是每收件人自有複本，刪自己的不影響他人
    const atts = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id = ?`)
      .bind(m.id)
      .all<{ r2_key: string | null }>();

    const guard = `AND EXISTS (SELECT 1 FROM messages WHERE id = ?1 AND folder IN (${folderSql}) AND folder_changed_at IS NULL ${exempt})`;
    const res = await env.DB.batch([
      env.DB.prepare(`DELETE FROM message_labels WHERE message_id = ?1 ${guard}`).bind(m.id),
      env.DB.prepare(`DELETE FROM attachments WHERE message_id = ?1 ${guard}`).bind(m.id),
      env.DB.prepare(`DELETE FROM follow_ups WHERE message_id = ?1 ${guard}`).bind(m.id),
      env.DB.prepare(
        `DELETE FROM messages WHERE id = ?1 AND folder IN (${folderSql}) AND folder_changed_at IS NULL ${exempt}`,
      ).bind(m.id),
    ]);
    if ((res[3]?.meta.changes ?? 0) !== 1) continue; // 認領與交易之間被救回 → 整組落空

    // 列已確定刪除 → 收尾清 R2 與 FTS（threads 列刻意保留——空 thread 無害，讀取皆 join messages）
    const keys = [r2RawKey(m.user_id, m.id), r2HtmlKey(m.user_id, m.id), r2CalKey(m.user_id, m.id)];
    for (const a of atts.results) if (a.r2_key) keys.push(a.r2_key);
    await env.MAIL_STORE.delete(keys);
    await env.DB_FTS.prepare(
      `DELETE FROM messages_fts WHERE rowid IN (SELECT fts_rowid FROM msg_map WHERE message_id = ?)`,
    )
      .bind(m.id)
      .run();
    await env.DB_FTS.prepare(`DELETE FROM msg_map WHERE message_id = ?`).bind(m.id).run();
    purged++;
  }
  return purged;
}
