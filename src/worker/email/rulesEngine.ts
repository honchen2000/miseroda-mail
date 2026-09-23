// 自動規則引擎：信件落地時依優先序套用（由上而下，每條規則依 match=all/any 決定是否觸發動作）
// 來源不限 ingest（外部信）—— 站內直送也會經過這裡。
// 條件以「子句（clause）」陣列表達：欄位(from/subject/to) × 運算子(contains/…) × 值；
// 另保留舊版扁平欄位（fromContains/…）向後相容。運算子皆為字串比對，無 regex → 無 ReDoS 風險。
import { newId } from '../lib/ids';
import { trustLevel, type AuthVerdict } from './authVerdict';

/** F2.8a：messages.auth_verdict（JSON 或 NULL）→ 規則比對用等級。NULL/壞 JSON → 'none'（未驗證）。 */
export type VerdictField = 'pass' | 'fail' | 'partial' | 'none';
export function authVerdictField(json: string | null | undefined): VerdictField {
  if (!json) return 'none';
  try {
    return trustLevel(JSON.parse(json) as AuthVerdict) ?? 'none';
  } catch {
    return 'none';
  }
}

export type ClauseField = 'from' | 'subject' | 'to' | 'cc' | 'recipient';
export type ClauseOp = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith';
export interface RuleClause {
  field: ClauseField;
  op: ClauseOp;
  value: string;
}

export interface RuleConditions {
  /** 多條件如何組合：全部符合(all，預設) / 任一符合(any) */
  match?: 'all' | 'any';
  clauses?: RuleClause[];
  hasListUnsubscribe?: boolean;
  /** AI 分類條件（帳單/工作/朋友/電子報/通知/其他）。落信當下尚未分類 → 由分類完成後的第二趟比對。 */
  aiCategory?: string;
  /** F2.8a：寄件驗證等級條件（fail=DMARC 對齊失敗等；none=完全未驗證）。落信當下即可評估（第一趟）。 */
  authVerdict?: 'fail' | 'none' | 'pass' | 'partial';
  /** F4.1a：是否有附件。 */
  hasAttachment?: boolean;
  /** F4.1a：信件大於 N KB（含附件）。 */
  sizeOverKb?: number;
  /** F4.1a：收信超過 N 天（落信當下幾乎為 0 → 主要對既有信生效）。 */
  olderThanDays?: number;
  // 舊版扁平欄位（向後相容；等同 contains 子句）
  fromContains?: string;
  subjectContains?: string;
  toContains?: string;
}

export type SnoozePreset = 'evening' | 'tomorrow' | 'weekend';
export interface RuleActions {
  addLabelId?: string;
  moveToFolder?: 'archive' | 'spam' | 'trash';
  star?: boolean;
  markRead?: boolean;
  /** 相對排程：今晚 / 明早 / 週末 —— 落地時設 snoozed_until（沿用既有 snooze + sweep 喚醒）。 */
  snooze?: SnoozePreset;
  /** 設跟進：到達後 N 分鐘提醒（寫 follow_ups，沿用 sweep 觸發）。 */
  followUpAfterMin?: number;
  /** F4.1a：遇到即停——此規則命中後，後續較低優先序的規則不再套用。 */
  stopProcessing?: boolean;
  /** F4.1b：自動轉寄到此 email（限聯絡人或站內，於規則建立時驗證；執行時再驗一次）。轉寄信本身不再被轉寄（迴圈防護）。 */
  forward?: string;
}

const TPE = 8 * 3_600_000; // 台灣 UTC+8（全年無日光節約）

/** snooze 相對預設 → 絕對喚醒時間（UTC epoch ms），台北牆鐘語意，對齊前端 snoozePresets。 */
export function snoozeTargetMs(preset: SnoozePreset, now: number): number {
  const t = now + TPE; // 視為台北牆鐘 epoch
  const midnight = Math.floor(t / 86_400_000) * 86_400_000; // 台北當日 00:00（牆鐘 epoch）
  const hour = Math.floor((t - midnight) / 3_600_000);
  const at = (addDays: number, h: number) => midnight + addDays * 86_400_000 + h * 3_600_000 - TPE;
  if (preset === 'evening') return hour < 19 ? at(0, 19) : at(1, 8); // 今晚 19:00；過了就明早 8:00
  if (preset === 'tomorrow') return at(hour < 8 ? 0 : 1, 8); // 明早 8:00（未過今早 8 點則今天）
  // 週末：本週六 08:00；epoch day 0(1970-01-01) 為週四 → dow=(day+4)%7，週六=6。
  const dow = Math.floor(t / 86_400_000 + 4) % 7;
  let daysToSat = (6 - dow + 7) % 7; // 到本週六的天數（今天就是週六則 0）
  if (daysToSat === 0 && hour >= 8) daysToSat = 7; // 週六但已過早上 8 點 → 下週六（否則仍取今天 8:00）
  return at(daysToSat, 8);
}

/** 規則比對所需的（已小寫化）欄位文字。 */
export interface MatchFields {
  from: string; // `${from_name} ${from_addr}`
  subject: string;
  to: string; // to_addrs
  hasListUnsubscribe: boolean;
  aiCategory?: string | null; // AI 分類；落信當下為 null（未分類）→ ai_category 條件不成立
  authVerdict?: VerdictField; // F2.8a：寄件驗證等級（未提供 → authVerdict 條件不成立，保守）
  cc?: string; // F4.1a：cc_addrs（小寫）
  recipient?: string; // F4.1a：to + cc（小寫；「任一收件人」）
  hasAttachment?: boolean; // F4.1a：是否有附件（未提供 → has_attachment 條件不成立）
  sizeBytes?: number; // F4.1a：信件大小（未提供 → 視為 0，sizeOverKb 不成立）
  ageMs?: number; // F4.1a：距今多久（未提供 → 視為 0，olderThanDays 不成立）
}

function fieldText(field: ClauseField, f: MatchFields): string {
  switch (field) {
    case 'from': return f.from;
    case 'subject': return f.subject;
    case 'to': return f.to;
    case 'cc': return f.cc ?? '';
    case 'recipient': return f.recipient ?? `${f.to} ${f.cc ?? ''}`;
    default: return '';
  }
}

function evalOp(op: ClauseOp, hay: string, needleRaw: string): boolean {
  const needle = needleRaw.toLowerCase();
  switch (op) {
    case 'contains':
      return hay.includes(needle);
    case 'notContains':
      return !hay.includes(needle);
    case 'equals':
      return hay.trim() === needle.trim();
    case 'startsWith':
      return hay.startsWith(needle);
    case 'endsWith':
      return hay.endsWith(needle);
    default:
      return false;
  }
}

/**
 * 純函式：判斷一條規則的條件是否成立（便於單元測試）。
 * 收集所有子句 + 舊版扁平條件 + hasListUnsubscribe 為一組布林檢查，依 match 組合。
 * 無任何有效條件 → 視為不成立（避免空條件規則誤觸全部信件）。
 */
export function matchesConditions(cond: RuleConditions, f: MatchFields): boolean {
  const checks: boolean[] = [];

  for (const cl of cond.clauses ?? []) {
    if (!cl || typeof cl.value !== 'string' || cl.value === '') continue;
    checks.push(evalOp(cl.op, fieldText(cl.field, f), cl.value));
  }
  // 舊版扁平欄位 → 等同 contains
  if (cond.fromContains) checks.push(f.from.includes(cond.fromContains.toLowerCase()));
  if (cond.subjectContains) checks.push(f.subject.includes(cond.subjectContains.toLowerCase()));
  if (cond.toContains) checks.push(f.to.includes(cond.toContains.toLowerCase()));
  if (cond.hasListUnsubscribe !== undefined) checks.push(f.hasListUnsubscribe === cond.hasListUnsubscribe);
  // AI 分類：f.aiCategory 未提供（落信第一趟）時恆不成立 → ai_category 規則留待分類完成後的第二趟。
  if (cond.aiCategory) checks.push(f.aiCategory === cond.aiCategory);
  // F2.8a：寄件驗證等級直接等值比對；f.authVerdict 未提供（舊呼叫端）→ 恆不成立（保守，不誤觸）。
  if (cond.authVerdict) checks.push(f.authVerdict === cond.authVerdict);
  // F4.1a：附件 / 大小 / 信齡。欄位未提供時一律保守不成立（hasAttachment 用嚴格 === ；數值用 ?? 0）。
  if (cond.hasAttachment !== undefined) checks.push(f.hasAttachment === cond.hasAttachment);
  if (cond.sizeOverKb) checks.push((f.sizeBytes ?? 0) > cond.sizeOverKb * 1024);
  if (cond.olderThanDays) checks.push((f.ageMs ?? 0) > cond.olderThanDays * 86_400_000);

  if (checks.length === 0) return false;
  return cond.match === 'any' ? checks.some((c) => c) : checks.every((c) => c);
}

interface RuleRow {
  id: string;
  conditions: string;
  actions: string;
  priority: number; // F4.1a：cross-pass stopProcessing 用
}

interface MessageLike {
  id: string;
  user_id: string;
  from_addr: string;
  from_name: string;
  subject: string;
  folder: string;
  to_addrs?: string;
  cc_addrs?: string;          // F4.1a
  has_attachments?: number;   // F4.1a（0/1）
  size_bytes?: number;        // F4.1a
  received_at?: number;       // F4.1a（算信齡）
}

export interface RuleContext {
  hasListUnsubscribe: boolean;
  /** 是否為訊息首次落地（非去重重跑）。star/markRead 僅在首次套用，避免重跑覆蓋使用者手動「標未讀/取消星標」。預設 true。 */
  firstInsert?: boolean;
  /** F2.8a：寄件驗證等級（由 authVerdictField(msg.auth_verdict) 算出）；未給 → authVerdict 條件不成立。 */
  authVerdict?: VerdictField;
  /** F4.1a：第一趟（applyRules）若於某 priority 停止 → 第二趟跳過 priority 更大（更低優先序）的 AI 分類規則。 */
  stopAtPriority?: number | null;
  /** F4.1b：此封信本身是「規則自動轉寄」產生的 → 不再收集任何 forward 目標（斷迴圈）。 */
  isForwarded?: boolean;
}

export interface ApplyResult {
  /** 觸發停止的規則 priority（供 ingest 把 cross-pass 停止帶進 AI 分類第二趟）；無停止則 null。 */
  stopPriority: number | null;
  /** F4.1b：命中規則要求轉寄的目標 email（已小寫去重；validation/enqueue 由呼叫端負責）。 */
  forwardTargets: string[];
}
export async function applyRules(env: Env, msg: MessageLike, ctx: RuleContext): Promise<ApplyResult> {
  const rules = await env.DB.prepare(
    `SELECT id, conditions, actions, priority FROM rules WHERE user_id = ? AND enabled = 1 ORDER BY priority, created_at`,
  )
    .bind(msg.user_id)
    .all<RuleRow>();
  if (!rules.results.length) return { stopPriority: null, forwardTargets: [] };

  const cc = (msg.cc_addrs ?? '').toLowerCase();
  const to = (msg.to_addrs ?? '').toLowerCase();
  const fields: MatchFields = {
    from: `${msg.from_name} ${msg.from_addr}`.toLowerCase(),
    subject: msg.subject.toLowerCase(),
    to,
    hasListUnsubscribe: ctx.hasListUnsubscribe,
    authVerdict: ctx.authVerdict,
    cc,
    recipient: `${to} ${cc}`,
    hasAttachment: msg.has_attachments != null ? !!msg.has_attachments : undefined,
    sizeBytes: msg.size_bytes,
    ageMs: msg.received_at != null ? Date.now() - msg.received_at : undefined,
  };

  let folder: string | null = null;
  let star = false;
  let markRead = false;
  let snooze: SnoozePreset | null = null;
  let followUpAfterMin = 0;
  let stopPriority: number | null = null;
  const labelIds = new Set<string>();
  const forwardTargets = new Set<string>();

  for (const rule of rules.results) {
    let cond: RuleConditions;
    let act: RuleActions;
    try {
      cond = JSON.parse(rule.conditions) as RuleConditions;
      act = JSON.parse(rule.actions) as RuleActions;
    } catch {
      continue;
    }
    if (!matchesConditions(cond, fields)) continue;

    if (act.addLabelId) labelIds.add(act.addLabelId);
    if (act.moveToFolder) folder = act.moveToFolder;
    if (act.star) star = true;
    if (act.markRead) markRead = true;
    if (act.snooze === 'evening' || act.snooze === 'tomorrow' || act.snooze === 'weekend') snooze = act.snooze;
    if (typeof act.followUpAfterMin === 'number' && act.followUpAfterMin > 0) followUpAfterMin = act.followUpAfterMin;
    // F4.1b：收集轉寄目標——但轉寄信本身（isForwarded）不再轉寄（斷迴圈）。validation/enqueue 在呼叫端。
    if (!ctx.isForwarded && typeof act.forward === 'string' && act.forward.trim()) {
      forwardTargets.add(act.forward.trim().toLowerCase());
    }
    if (act.stopProcessing) {
      stopPriority = rule.priority; // F4.1a：記下停止點 priority；後續較低優先序規則（含 AI 分類第二趟）不再套用
      break;
    }
  }

  await applyAccumulated(env, msg, { folder, star, markRead, snooze, followUpAfterMin, labelIds }, ctx.firstInsert !== false);
  return { stopPriority, forwardTargets: [...forwardTargets] };
}

interface Accumulated {
  folder: string | null;
  star: boolean;
  markRead: boolean;
  snooze: SnoozePreset | null;
  followUpAfterMin: number;
  labelIds: Set<string>;
}

/** 把累積的動作寫入 DB（applyRules 第一趟 與 applyAiCategoryRules 第二趟共用，動作邏輯單一來源）。 */
async function applyAccumulated(env: Env, msg: MessageLike, acc: Accumulated, oneShot: boolean): Promise<void> {
  const { folder, star, markRead, snooze, followUpAfterMin, labelIds } = acc;
  const stmts: D1PreparedStatement[] = [];
  if (folder && msg.folder === 'inbox') {
    stmts.push(env.DB.prepare(`UPDATE messages SET folder = ? WHERE id = ? AND user_id = ?`).bind(folder, msg.id, msg.user_id));
  }
  // star/markRead 僅首次套用：去重重跑（deliver dedup）時不再強制，避免覆蓋使用者後續手動「標未讀/取消星標」
  if (star && oneShot) {
    stmts.push(env.DB.prepare(`UPDATE messages SET is_starred = 1 WHERE id = ? AND user_id = ?`).bind(msg.id, msg.user_id));
  }
  if (markRead && oneShot) {
    stmts.push(env.DB.prepare(`UPDATE messages SET is_read = 1 WHERE id = ? AND user_id = ?`).bind(msg.id, msg.user_id));
  }
  for (const labelId of labelIds) {
    // 標籤必須屬於同一使用者，避免規則被塞入他人 label id
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO message_labels (message_id, label_id)
         SELECT ?, id FROM labels WHERE id = ? AND user_id = ?`,
      ).bind(msg.id, labelId, msg.user_id),
    );
  }
  // snooze / followUp 僅首次套用（oneShot）：避免去重重跑時重新 snooze 已喚醒的信、或重設跟進。
  const now = Date.now();
  const staysInInbox = msg.folder === 'inbox' && !folder; // 被搬走（archive/spam/trash）就不 snooze
  if (oneShot && snooze && staysInInbox) {
    stmts.push(
      env.DB.prepare(`UPDATE messages SET snoozed_until = ? WHERE id = ? AND user_id = ? AND folder = 'inbox'`).bind(
        snoozeTargetMs(snooze, now),
        msg.id,
        msg.user_id,
      ),
    );
  }
  if (oneShot && followUpAfterMin) {
    // thread_id/subject/ref_at 直接從信件列取（此時必存在）；UNIQUE(user_id,message_id) → 重跑冪等。
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, ref_at, status, created_at)
         SELECT ?, user_id, id, thread_id, subject, ?, 0, received_at, 'pending', ?
         FROM messages WHERE id = ? AND user_id = ?`,
      ).bind(newId('fu'), now + followUpAfterMin * 60_000, now, msg.id, msg.user_id),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

/** 是否有任何啟用中、用到 ai_category 條件的規則 → 成本守門：沒有就完全不跑 AI 分類。 */
export async function userHasAiCategoryRule(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM rules WHERE user_id = ? AND enabled = 1 AND conditions LIKE '%aiCategory%' LIMIT 1`,
  )
    .bind(userId)
    .first();
  return !!row;
}

/**
 * 第二趟：分類算出後，只對「含 ai_category 條件」的規則套用（其首次真正生效）。
 * 非 AI 規則第一趟已處理、這裡完全不碰。oneShot=true（這些規則的第一次套用）。
 */
export async function applyAiCategoryRules(
  env: Env,
  msg: MessageLike,
  ctx: RuleContext,
  category: string,
): Promise<void> {
  const rules = await env.DB.prepare(
    `SELECT id, conditions, actions, priority FROM rules WHERE user_id = ? AND enabled = 1 AND conditions LIKE '%aiCategory%' ORDER BY priority, created_at`,
  )
    .bind(msg.user_id)
    .all<RuleRow>();
  if (!rules.results.length) return;

  const cc = (msg.cc_addrs ?? '').toLowerCase();
  const to = (msg.to_addrs ?? '').toLowerCase();
  const base = {
    from: `${msg.from_name} ${msg.from_addr}`.toLowerCase(),
    subject: msg.subject.toLowerCase(),
    to,
    hasListUnsubscribe: ctx.hasListUnsubscribe,
    authVerdict: ctx.authVerdict, // F2.8a：含 authVerdict，讓 authVerdict×aiCategory 混合規則在第二趟可評估
    // F4.1a：含新欄位，讓 aiCategory×(cc/附件/大小/信齡) 混合規則在第二趟可評估
    cc,
    recipient: `${to} ${cc}`,
    hasAttachment: msg.has_attachments != null ? !!msg.has_attachments : undefined,
    sizeBytes: msg.size_bytes,
    ageMs: msg.received_at != null ? Date.now() - msg.received_at : undefined,
  };
  const fieldsWith: MatchFields = { ...base, aiCategory: category };
  const fieldsWithout: MatchFields = { ...base, aiCategory: undefined }; // 第一趟（落信）的狀態

  let folder: string | null = null;
  let star = false;
  let markRead = false;
  let snooze: SnoozePreset | null = null;
  let followUpAfterMin = 0;
  const labelIds = new Set<string>();

  for (const rule of rules.results) {
    // F4.1a：第一趟已於 stopAtPriority 停止 → 跳過 priority 更大（更低優先序）的 AI 分類規則。
    if (ctx.stopAtPriority != null && rule.priority > ctx.stopAtPriority) continue;
    let cond: RuleConditions;
    let act: RuleActions;
    try {
      cond = JSON.parse(rule.conditions) as RuleConditions;
      act = JSON.parse(rule.actions) as RuleActions;
    } catch {
      continue;
    }
    if (!cond.aiCategory) continue; // 只認真正用 ai_category 的規則（LIKE 可能誤命中字串）
    if (!matchesConditions(cond, fieldsWith)) continue;
    // 第一趟（無分類）就已符合 → 動作那時已套用，這裡不重複（避免 match=any 規則重設 star/snooze）。
    if (matchesConditions(cond, fieldsWithout)) continue;
    if (act.addLabelId) labelIds.add(act.addLabelId);
    if (act.moveToFolder) folder = act.moveToFolder;
    if (act.star) star = true;
    if (act.markRead) markRead = true;
    if (act.snooze === 'evening' || act.snooze === 'tomorrow' || act.snooze === 'weekend') snooze = act.snooze;
    if (typeof act.followUpAfterMin === 'number' && act.followUpAfterMin > 0) followUpAfterMin = act.followUpAfterMin;
    if (act.stopProcessing) break; // F4.1a：第二趟內的 stopProcessing 也停止後續 AI 分類規則
  }
  await applyAccumulated(env, msg, { folder, star, markRead, snooze, followUpAfterMin, labelIds }, true);
}

export interface RunOnExistingResult {
  matched: number;
  applied: number;
  sample: { id: string; from: string; subject: string }[];
  /** 收件匣超過掃描上限被截斷（只看了最新 SCAN_CAP 封）→ UI 須揭露「未涵蓋較舊信件」。 */
  truncated: boolean;
}

/**
 * 把一條規則套用到「收件匣現有信」（整理 backlog）。
 * dryRun=true 只回符合數＋樣本、不異動任何資料。
 * 範圍刻意限收件匣：moveToFolder 本就只動 inbox；star/markRead/label 對符合的收件匣信套用——
 * 行為可預期、不會驚動已封存/寄件備份；moveToFolder 會把信移出收件匣 → 重跑自然冪等（已移出者不再符合掃描）。
 * 所有寫入皆 user_id scoped；label 經 INSERT...SELECT WHERE user_id 二次把關。
 */
export async function runRuleOnExisting(
  env: Env,
  userId: string,
  ruleId: string,
  opts: { dryRun: boolean },
): Promise<RunOnExistingResult | null> {
  const rule = await env.DB.prepare(`SELECT conditions, actions FROM rules WHERE id = ? AND user_id = ?`)
    .bind(ruleId, userId)
    .first<{ conditions: string; actions: string }>();
  if (!rule) return null;

  let cond: RuleConditions;
  let act: RuleActions;
  try {
    cond = JSON.parse(rule.conditions) as RuleConditions;
    act = JSON.parse(rule.actions) as RuleActions;
  } catch {
    return null;
  }

  // 多取一筆以偵測截斷：收件匣 > SCAN_CAP 時只看最新 SCAN_CAP 封，truncated=true 讓 UI 揭露。
  const SCAN_CAP = 5000;
  const rows = await env.DB.prepare(
    `SELECT id, from_addr, from_name, subject, to_addrs, cc_addrs, list_unsubscribe, ai_category, auth_verdict, has_attachments, size_bytes, received_at
     FROM messages WHERE user_id = ? AND folder = 'inbox' AND screening = 0 ORDER BY received_at DESC LIMIT ?`,
  )
    .bind(userId, SCAN_CAP + 1)
    .all<{
      id: string;
      from_addr: string;
      from_name: string;
      subject: string;
      to_addrs: string | null;
      cc_addrs: string | null;
      list_unsubscribe: string | null;
      ai_category: string | null;
      auth_verdict: string | null;
      has_attachments: number | null;
      size_bytes: number | null;
      received_at: number | null;
    }>();
  const truncated = rows.results.length > SCAN_CAP;
  const scanned = truncated ? rows.results.slice(0, SCAN_CAP) : rows.results;

  const now = Date.now();
  const matched = scanned.filter((m) => {
    const to = (m.to_addrs ?? '').toLowerCase();
    const cc = (m.cc_addrs ?? '').toLowerCase();
    return matchesConditions(cond, {
      from: `${m.from_name} ${m.from_addr}`.toLowerCase(),
      subject: m.subject.toLowerCase(),
      to,
      hasListUnsubscribe: m.list_unsubscribe != null,
      aiCategory: m.ai_category, // ai_category 規則對「已分類過的既有信」生效；未分類者(null)不符（合理）
      authVerdict: authVerdictField(m.auth_verdict), // F2.8a：對既有信也能用驗證等級條件
      // F4.1a：cc/收件人/附件/大小/信齡（older_than 主要對既有信生效）
      cc,
      recipient: `${to} ${cc}`,
      hasAttachment: m.has_attachments != null ? !!m.has_attachments : undefined,
      sizeBytes: m.size_bytes ?? undefined,
      ageMs: m.received_at != null ? now - m.received_at : undefined,
    });
  });

  const sample = matched.slice(0, 6).map((m) => ({ id: m.id, from: m.from_addr, subject: m.subject }));
  const hasAction = !!(act.moveToFolder || act.star || act.markRead || act.addLabelId);
  if (opts.dryRun || !hasAction) return { matched: matched.length, applied: 0, sample, truncated };

  const CHUNK = 40;
  let applied = 0;
  for (let i = 0; i < matched.length; i += CHUNK) {
    const slice = matched.slice(i, i + CHUNK);
    const stmts: D1PreparedStatement[] = [];
    for (const m of slice) {
      if (act.moveToFolder)
        stmts.push(env.DB.prepare(`UPDATE messages SET folder = ? WHERE id = ? AND user_id = ?`).bind(act.moveToFolder, m.id, userId));
      // star/markRead 僅在狀態不同時才寫（AND is_starred=0 / is_read=0）：對齊 ingest applyRules 的 oneShot 不變式，
      // 避免重跑把使用者手動「取消星標 / 標未讀」又蓋回去。
      if (act.star) stmts.push(env.DB.prepare(`UPDATE messages SET is_starred = 1 WHERE id = ? AND user_id = ? AND is_starred = 0`).bind(m.id, userId));
      if (act.markRead) stmts.push(env.DB.prepare(`UPDATE messages SET is_read = 1 WHERE id = ? AND user_id = ? AND is_read = 0`).bind(m.id, userId));
      if (act.addLabelId)
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO message_labels (message_id, label_id)
             SELECT ?, id FROM labels WHERE id = ? AND user_id = ?`,
          ).bind(m.id, act.addLabelId, userId),
        );
    }
    if (stmts.length) await env.DB.batch(stmts);
    applied += slice.length;
  }
  return { matched: matched.length, applied, sample, truncated };
}
