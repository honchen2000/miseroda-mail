// F10.1：Ask AI 信箱問答的檢索管線（RAG over own mail）。
// 流程：AI 抽關鍵字（呼叫端）→ 本模組以 FTS trigram 檢索聯集 → 組編號片段給 AI 作答。
// 隱私邊界：只查 user_id 自己的信；片段只進 AI 呼叫與快取，不落任何新表。

export interface AskSource {
  id: string;
  subject: string;
  from: string;
  receivedAt: number;
  excerpt: string;
}

/** AI 關鍵字輸出 → 清洗成 1-4 個關鍵字（純函式，可測）。容錯：逗號/頓號/換行分割、去引號與前綴、去重。 */
export function parseKeywords(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,，、\n;]+/)) {
    const k = part
      .replace(/^["'「『`\s]+|["'」』`\s]+$/g, '')
      .replace(/^關鍵字[:：]?\s*/, '')
      .trim();
    if (!k || k.length > 40) continue; // 過長＝AI 沒照格式（整句），丟棄
    if (!out.some((x) => x.toLowerCase() === k.toLowerCase())) out.push(k);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * 逐關鍵字檢索（FTS trigram phrase；<3 字元 fallback 主庫 LIKE），聯集去重，
 * 依 received_at DESC 取 top-N，附 FTS body_text 節錄。
 */
export async function retrieveAskContext(
  env: Env,
  userId: string,
  keywords: string[],
  limit = 8,
  /** 請求路徑請傳 `c.var.db`（走 D1 session）；省略＝主庫。注意 DB_FTS 一律直查主庫（FTS 未納入 session）。 */
  db: D1Database | D1DatabaseSession = env.DB,
): Promise<AskSource[]> {
  const ids = new Set<string>();
  for (const kw of keywords) {
    if (kw.length >= 3) {
      const ftsQ = `"${kw.replace(/"/g, '""')}"`; // trigram phrase＝子字串比對（中文 OK）
      const hits = await env.DB_FTS.prepare(
        `SELECT m.message_id FROM messages_fts f JOIN msg_map m ON m.fts_rowid = f.rowid
         WHERE messages_fts MATCH ? AND m.user_id = ? LIMIT 40`,
      )
        .bind(ftsQ, userId)
        .all<{ message_id: string }>();
      for (const h of hits.results) ids.add(h.message_id);
    } else {
      // 1–2 字：主庫 LIKE（主旨/寄件者/摘要），與搜尋端點同 fallback 策略
      const esc = kw.replace(/[%_\\]/g, (ch) => `\\${ch}`);
      const rows = await db.prepare(
        `SELECT id FROM messages WHERE user_id = ?1
           AND (subject LIKE ?2 ESCAPE '\\' OR snippet LIKE ?2 ESCAPE '\\' OR from_name LIKE ?2 ESCAPE '\\' OR from_addr LIKE ?2 ESCAPE '\\')
         LIMIT 40`,
      )
        .bind(userId, `%${esc}%`)
        .all<{ id: string }>();
      for (const r of rows.results) ids.add(r.id);
    }
  }
  if (!ids.size) return [];

  const idList = [...ids].slice(0, 120); // 綁定參數上限保險
  const rows = await db.prepare(
    `SELECT id, subject, from_name, from_addr, received_at, snippet FROM messages
     WHERE user_id = ? AND id IN (${idList.map(() => '?').join(',')}) AND folder NOT IN ('trash', 'spam')
     ORDER BY received_at DESC LIMIT ?`,
  )
    .bind(userId, ...idList, limit)
    .all<{ id: string; subject: string; from_name: string; from_addr: string; received_at: number; snippet: string }>();

  const sources: AskSource[] = [];
  for (const m of rows.results) {
    // 內文節錄從 FTS 庫拿（已是純文字），不用重讀 R2；缺漏時退回 snippet
    const body = await env.DB_FTS.prepare(
      `SELECT f.body_text AS t FROM messages_fts f JOIN msg_map mm ON mm.fts_rowid = f.rowid WHERE mm.message_id = ?`,
    )
      .bind(m.id)
      .first<{ t: string | null }>();
    sources.push({
      id: m.id,
      subject: m.subject,
      from: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr,
      receivedAt: m.received_at,
      excerpt: (body?.t || m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 800),
    });
  }
  return sources;
}
