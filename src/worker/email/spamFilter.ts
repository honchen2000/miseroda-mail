// 每使用者貝氏垃圾分類器（無 AI 成本、純函式可測）。
// 取自 Paul Graham「A Plan for Spam」：以 token 出現與否估 P(spam|token)，取最具區辨力的前 N 個以朴素貝氏合併。
// 中文無詞界 → 用字元 bigram；英數 → 單詞 token。學習資料來自使用者「回報垃圾 / 封存 / 從垃圾救回」等動作。
// 設計保守：訓練量不足前（見 ingest 的門檻）一律不自動判垃圾，避免誤殺重要信。

export interface TokenStat {
  spam: number;
  ham: number;
}
export interface CorpusStat {
  spamMsgs: number;
  hamMsgs: number;
}

const MAX_TOKENS = 80; // 每封信去重後最多取用的 token 數（界定計算與儲存量）
const TOP_N = 15; // 合併時取最具區辨力的前 N 個 token（Graham）
const MIN_OCC = 3; // token 總出現未達此數 → 視為未見過（中性 0.4），避免單次出現的 token 給出 0.99 而誤判（Graham 的 hapax 防護）

/** 由主旨 + 內文（摘要即可）抽出去重後的 token。 */
export function tokenize(subject: string, body: string): string[] {
  const text = `${subject}\n${body}`.toLowerCase();
  const tokens = new Set<string>();
  // 英數單詞（2–20 字）
  for (const m of text.matchAll(/[a-z0-9][a-z0-9'._%+-]{1,19}/g)) tokens.add(`w:${m[0]}`);
  // CJK：字元 bigram（單字則取該字）
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) tokens.add(`c:${run}`);
    for (let i = 0; i + 1 < run.length; i++) tokens.add(`c:${run.slice(i, i + 2)}`);
  }
  return [...tokens].slice(0, MAX_TOKENS);
}

/** 單一 token 的 spam 機率（Graham 平滑：spam 計數加權 ×2、夾在 [0.01, 0.99]、未見過取中性 0.4）。 */
function tokenProb(stat: TokenStat | undefined, corpus: CorpusStat): number {
  const s = stat?.spam ?? 0;
  const h = stat?.ham ?? 0;
  if (s + h < MIN_OCC) return 0.4; // 未見過 / 出現太少 → 中性偏 ham（防單次出現 token 過度自信）
  const spamFreq = Math.min(1, (s * 2) / Math.max(1, corpus.spamMsgs));
  const hamFreq = Math.min(1, h / Math.max(1, corpus.hamMsgs));
  if (spamFreq + hamFreq === 0) return 0.4;
  return Math.max(0.01, Math.min(0.99, spamFreq / (spamFreq + hamFreq)));
}

/** 綜合 spam 機率（取最具區辨力前 TOP_N 個 token，朴素貝氏）。回傳 0..1；無 token → 0。 */
export function scoreSpam(tokens: string[], stats: Map<string, TokenStat>, corpus: CorpusStat): number {
  if (!tokens.length) return 0;
  const probs = tokens.map((t) => tokenProb(stats.get(t), corpus));
  probs.sort((a, b) => Math.abs(b - 0.5) - Math.abs(a - 0.5)); // 距 0.5 最遠者最具區辨力
  const top = probs.slice(0, TOP_N);
  let prod = 1;
  let inv = 1;
  for (const p of top) {
    prod *= p;
    inv *= 1 - p;
  }
  return prod / (prod + inv);
}
