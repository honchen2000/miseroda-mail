// 貝氏垃圾分類器的 D1 學習 / 評分（純函式核心在 spamFilter.ts）。
// 訓練資料來自使用者動作：回報垃圾→spam、封存（非垃圾匣內）/ 從垃圾救回→ham。
// 以 messages.spam_trained 做 compare-and-swap 認領，確保重試 / 並發 / 雙擊不會重複計數；
// 兩階段（CAS 一批 + 增量一批）→ 不論幾封都只 2 次 round-trip。
import { scoreSpam, tokenize, type TokenStat } from './spamFilter';

export const MIN_TRAIN = 5; // 每類至少 N 封已訓練才啟用自動判垃圾（保守：不足前一律不判）
export const SPAM_THRESHOLD = 0.9; // 貝氏機率門檻（保守，降低誤殺）

export interface TrainableMsg {
  id: string;
  subject: string;
  snippet: string;
  spam_trained: string | null;
  folder?: string;
  direction?: string;
}

type Target = 'spam' | 'ham';

/** 反向修正先前類別 + 套用新類別的 token / 語料增量語句（不含 spam_trained 標記，標記由 CAS 階段完成）。 */
function incrementStmts(env: Env, userId: string, tokens: string[], prev: string | null, target: Target): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  if (prev === 'spam' || prev === 'ham') {
    const pc = prev === 'spam' ? 'spam_count' : 'ham_count';
    const ps = prev === 'spam' ? 'spam_msgs' : 'ham_msgs';
    for (const t of tokens) {
      stmts.push(env.DB.prepare(`UPDATE spam_tokens SET ${pc} = MAX(0, ${pc} - 1) WHERE user_id = ? AND token = ?`).bind(userId, t));
    }
    stmts.push(env.DB.prepare(`UPDATE spam_train_stats SET ${ps} = MAX(0, ${ps} - 1) WHERE user_id = ?`).bind(userId));
  }
  const col = target === 'spam' ? 'spam_count' : 'ham_count';
  const stat = target === 'spam' ? 'spam_msgs' : 'ham_msgs';
  for (const t of tokens) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO spam_tokens (user_id, token, ${col}) VALUES (?, ?, 1)
         ON CONFLICT(user_id, token) DO UPDATE SET ${col} = ${col} + 1`,
      ).bind(userId, t),
    );
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO spam_train_stats (user_id, ${stat}) VALUES (?, 1)
       ON CONFLICT(user_id) DO UPDATE SET ${stat} = ${stat} + 1`,
    ).bind(userId),
  );
  return stmts;
}

/**
 * 依資料夾轉移訓練：→spam 訓練 spam；→archive（非垃圾匣內）或（原本在 spam → 移回收件匣）訓練 ham。
 * 其餘 / 寄件備份不訓練。idempotent：以 spam_trained 的 CAS 認領，重試 / 並發不重複計數。
 */
export async function trainFromFolderChange(env: Env, userId: string, msgs: TrainableMsg[], newFolder: string): Promise<void> {
  const todo: { m: TrainableMsg; target: Target }[] = [];
  for (const m of msgs) {
    if (m.direction === 'outbound') continue; // 只訓練收到的信
    let target: Target | null = null;
    if (newFolder === 'spam') target = 'spam';
    else if ((newFolder === 'archive' && m.folder !== 'spam') || (m.folder === 'spam' && newFolder === 'inbox')) target = 'ham';
    if (target && m.spam_trained !== target) todo.push({ m, target });
  }
  if (!todo.length) return;

  // 階段一：CAS 認領（spam_trained 由預取值 → target，只有目前仍等於預取值才成功）→ 防重試/並發重複計數
  const casResults = await env.DB.batch(
    todo.map(({ m, target }) =>
      env.DB
        .prepare(
          `UPDATE messages SET spam_trained = ?
           WHERE id = ? AND user_id = ? AND (spam_trained = ? OR (spam_trained IS NULL AND ? IS NULL))`,
        )
        .bind(target, m.id, userId, m.spam_trained, m.spam_trained),
    ),
  );

  // 階段二：對認領成功者累積增量，單一 batch 套用
  const incStmts: D1PreparedStatement[] = [];
  casResults.forEach((res, i) => {
    if ((res.meta.changes ?? 0) !== 1) return; // 未認領（已被其他請求改動）→ 跳過
    const { m, target } = todo[i];
    const tokens = tokenize(m.subject ?? '', m.snippet ?? '');
    incStmts.push(...incrementStmts(env, userId, tokens, m.spam_trained, target));
  });
  if (incStmts.length) await env.DB.batch(incStmts);
}

/**
 * 對新進信件評分：訓練量達門檻、且貝氏機率 ≥ 門檻才回 true（判垃圾）。
 * 保守設計：訓練不足一律回 false，不自動判垃圾。
 */
export async function scoreInbound(env: Env, userId: string, subject: string, body: string): Promise<boolean> {
  const stats = await env.DB.prepare(`SELECT spam_msgs, ham_msgs FROM spam_train_stats WHERE user_id = ?`)
    .bind(userId)
    .first<{ spam_msgs: number; ham_msgs: number }>();
  if (!stats || stats.spam_msgs < MIN_TRAIN || stats.ham_msgs < MIN_TRAIN) return false;

  const tokens = tokenize(subject, body);
  if (!tokens.length) return false;
  const rows = await env.DB.prepare(
    `SELECT token, spam_count, ham_count FROM spam_tokens WHERE user_id = ? AND token IN (${tokens.map(() => '?').join(',')})`,
  )
    .bind(userId, ...tokens)
    .all<{ token: string; spam_count: number; ham_count: number }>();
  const map = new Map<string, TokenStat>(rows.results.map((r) => [r.token, { spam: r.spam_count, ham: r.ham_count }]));
  const prob = scoreSpam(tokens, map, { spamMsgs: stats.spam_msgs, hamMsgs: stats.ham_msgs });
  return prob >= SPAM_THRESHOLD;
}
