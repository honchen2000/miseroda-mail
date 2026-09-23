// F12.1：D1 每日自動備份 → R2 `backup/YYYY-MM-DD/<table>.jsonl` + 輪替。
// 定位：D1 Time Travel（30 天 PITR）是第一還原手段；本備份提供 >30 天保存與可讀 dump。
// 誠實邊界：R2 與 D1 同 Cloudflare 帳號——不防帳號級災難；真異地保存見 docs/restore-runbook.md 的手動下載節。
// FTS 庫不備份（可用 admin /fts/rebuild 全量重建）；KV 為快取/冪等鍵不備份。

export const BACKUP_CRON = '0 18 * * *'; // UTC 18:00 = 台北 02:00

// 短命/純快取表不備份：sessions（還原後全員重登即可）、challenges（幾分鐘就過期）
const SKIP_TABLES = new Set(['sessions', 'challenges']);

/** 輪替判定（純函式，可測）：日備份保留 30 天；每月 1 日的備份保留 365 天。 */
export function shouldKeepBackup(day: string, today: string): boolean {
  const d = Date.parse(`${day}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(t)) return true; // 解析不了 → 往「保留」方向失敗
  const ageDays = (t - d) / 86400_000;
  if (ageDays <= 30) return true;
  if (day.endsWith('-01') && ageDays <= 365) return true;
  return false;
}

export async function runBackup(env: Env, now = Date.now()): Promise<{ day: string; tables: Record<string, number> } | null> {
  const day = new Date(now).toISOString().slice(0, 10);
  // 冪等：同日已完成就跳過（cron 重試/重疊安全）
  const marker = `backup:done:${day}`;
  if (await env.KV.get(marker)) return null;

  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'd1\\_%' ESCAPE '\\'`,
  ).all<{ name: string }>();

  const manifest: Record<string, number> = {};
  for (const t of tables.results) {
    if (SKIP_TABLES.has(t.name)) continue;
    // 分頁 dump（本專案無 WITHOUT ROWID 表，LIMIT/OFFSET 對備份量級足夠）
    const lines: string[] = [];
    const PAGE = 500;
    for (let offset = 0; ; offset += PAGE) {
      const rows = await env.DB.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}" ORDER BY rowid LIMIT ${PAGE} OFFSET ${offset}`).all();
      for (const r of rows.results) lines.push(JSON.stringify(r));
      if (rows.results.length < PAGE) break;
    }
    await env.MAIL_STORE.put(`backup/${day}/${t.name}.jsonl`, lines.join('\n'), {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
    manifest[t.name] = lines.length;
  }
  await env.MAIL_STORE.put(
    `backup/${day}/_manifest.json`,
    JSON.stringify({ day, generatedAt: now, tables: manifest }, null, 1),
    { httpMetadata: { contentType: 'application/json' } },
  );
  await env.KV.put(marker, '1', { expirationTtl: 3 * 86400 });

  await rotateBackups(env, day);
  return { day, tables: manifest };
}

/** 輪替：只動 `backup/YYYY-MM-DD/` 格式的 key（regex 守門，絕不誤及其他 prefix）。 */
async function rotateBackups(env: Env, today: string): Promise<void> {
  const toDelete: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.MAIL_STORE.list({ prefix: 'backup/', cursor, limit: 1000 });
    for (const o of listed.objects) {
      const m = /^backup\/(\d{4}-\d{2}-\d{2})\//.exec(o.key);
      if (m && !shouldKeepBackup(m[1], today)) toDelete.push(o.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < toDelete.length; i += 100) {
    await env.MAIL_STORE.delete(toDelete.slice(i, i + 100));
  }
}
