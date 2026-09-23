// F4.1b：規則自動轉寄。把命中「轉寄」規則的信，以「本人身分」轉寄到聯絡人或站內地址。
//
// 迴圈防護（三層，缺一不可）：
//   (1) 轉寄信打 X-Miseroda-Forwarded（外寄）/ 帶 forwarded 旗標（站內投遞）→ 落地時 ctx.isForwarded=true
//       → applyRules 不再收集任何 forward 目標（轉寄信本身不會再被轉寄）。
//       F11：外寄標頭的「值」是本系統核發的隨機 marker（forward_markers 表），落地時查表命中才算數——
//       固定值 '1' 任何遠端寄件者都寫得出來，等於讓外人一鍵關掉收件人的轉寄規則。
//   (2) forwarded_log 去重（user×message×target PK）→ 同一封信對同一目標只轉一次（防 queue 重跑 / 重複套規則）。
//   (3) 不轉給自己（self-guard）→ 擋掉 trivial 迴圈。
// 目標限制（Hon 決策「僅限聯絡人或站內」）：站內 @MAIL_DOMAIN，或使用者的聯絡人（手動聯絡人或有往來地址）；
//   其餘一律拒絕，縮小外洩面。規則建立時於 settings 先驗一次，這裡執行時再驗一次（縱深防禦：聯絡人可能事後被刪）。
import { audit } from '../lib/audit';
import { randomToken } from '../lib/crypto';
import { newId } from '../lib/ids';
import type { SendJob } from '../jobs/types';

export interface ForwardSource {
  userId: string;
  /** 轉寄者本人 canonical email：寄出身分 + self-guard 用 */
  userEmail: string;
  /** 原信 id：forwarded_log 去重鍵 */
  messageId: string;
  fromAddr: string;
  fromName: string;
  subject: string;
  /** 原信 html（已消毒） */
  html: string;
  text: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

/**
 * 目標是否允許：站內「現存 active 使用者/別名」 or 聯絡人（手動/往來），且非本人。
 * 規則建立（settings）與執行（此檔）共用——縱深防禦：聯絡人/使用者可能事後變動，執行時再驗一次。
 */
export async function isForwardTargetAllowed(env: Env, userId: string, userEmail: string, target: string): Promise<boolean> {
  target = target.trim().toLowerCase();
  if (!target || target === userEmail.toLowerCase()) return false; // 不轉給自己（canonical 快路徑）
  if (target.endsWith(`@${env.MAIL_DOMAIN.toLowerCase()}`)) {
    // 站內：必須解析到「現存 active 使用者」或其別名（與 send route 一致）。
    // 否則未知域內地址會被當外部由 SEND_EMAIL 送出 → 繞回 catch-all，非預期。[Codex R1-1]
    const owner = await env.DB.prepare(
      `SELECT id FROM users WHERE status = 'active' AND lower(email) = ?1
       UNION
       SELECT u.id FROM aliases a JOIN users u ON u.id = a.user_id WHERE u.status = 'active' AND lower(a.address) = ?1`,
    )
      .bind(target)
      .first<{ id: string }>();
    if (!owner) return false; // 未知站內地址 → 拒絕
    return owner.id !== userId; // 自己的別名 / +tag → 拒絕（self-guard 縱深）[Codex R1-3]
  }
  const manual = await env.DB.prepare(`SELECT 1 FROM contacts WHERE user_id = ? AND lower(email) = ? LIMIT 1`)
    .bind(userId, target)
    .first();
  if (manual) return true;
  // 往來地址：曾「在 spam/trash 以外」收過對方（inbound from），或曾寄給對方（outbound to）。
  // 排除 spam/trash → 單一不請自來的垃圾信不會把寄件者變成可轉寄目標。[Codex R1-2]
  const seen = await env.DB.prepare(
    `SELECT 1 FROM messages WHERE user_id = ?1
       AND ( (direction = 'inbound' AND lower(from_addr) = ?2 AND folder NOT IN ('spam','trash'))
          OR (direction = 'outbound' AND EXISTS (SELECT 1 FROM json_each(to_addrs) je WHERE lower(je.value) = ?2)) )
     LIMIT 1`,
  )
    .bind(userId, target)
    .first();
  return !!seen;
}

/** 單封信最多轉寄目標數——防多條轉寄規則對同一封信扇出爆量、耗盡寄信額度。[Codex R1-4] */
const MAX_FORWARD_TARGETS_PER_MESSAGE = 5;

/* ---- F11：迴圈斷點 marker（系統核發，不信任遠端寫的標頭） ---- */

/**
 * marker 有效期。遠長於任何正常的「外寄→扇回」延遲（含外部 MTA 數天的重試佇列），
 * 迴圈防護不會因逾期而失效；但不永久有效，限制「收到轉寄信的外部收件人日後拿同一個 marker 重放」的窗口。
 * 過期列由 sweep 清掉。
 */
export const FORWARD_MARKER_TTL_MS = 7 * 86_400_000;
/** 單封信最多檢查幾個 X-Miseroda-Forwarded 值（遠端可塞任意多個同名標頭 → 限制查詢成本）。 */
const MAX_MARKER_CANDIDATES = 3;
/** 單一 marker 值長度上限（本系統核發的是 43 字元 base64url；超長一律不查）。 */
const MAX_MARKER_LEN = 128;

/**
 * 收到的 X-Miseroda-Forwarded 標頭值是否為「本系統核發、且仍在有效期內」的迴圈斷點 marker。
 *
 * 刻意「不」以收件人 user_id 收窄查詢：marker 是 256-bit 隨機值，外部寄件者偽造不出來，
 * 因此全站採信是安全的——而且必須全站採信，否則 A 的轉寄信扇回到 B 時 B 不認得，
 * 兩個使用者互相接力可以讓轉寄迴圈無限跑下去（每一代都是新 message id，forwarded_log 去不到重）。
 */
export async function hasSystemForwardMarker(env: Env, headerValues: (string | null | undefined)[]): Promise<boolean> {
  const candidates = [
    ...new Set(headerValues.map((v) => (v ?? '').trim()).filter((v) => v.length > 0 && v.length <= MAX_MARKER_LEN)),
  ].slice(0, MAX_MARKER_CANDIDATES);
  if (!candidates.length) return false;
  const hit = await env.DB.prepare(
    `SELECT 1 FROM forward_markers WHERE marker IN (${candidates.map(() => '?').join(',')}) AND created_at > ? LIMIT 1`,
  )
    .bind(...candidates, Date.now() - FORWARD_MARKER_TTL_MS)
    .first();
  return !!hit;
}

/**
 * 為命中的轉寄規則排程外寄。best-effort：單一目標失敗不影響收信或其他目標。
 * 先寫 forwarded_log 佔位再排程（at-most-once：寧可偶爾漏轉，也不重複轉寄/迴圈）。
 */
export async function enqueueForwards(env: Env, src: ForwardSource, targets: string[]): Promise<void> {
  const userEmail = src.userEmail.toLowerCase();
  if (targets.length > MAX_FORWARD_TARGETS_PER_MESSAGE) {
    console.warn(`forward fan-out capped: ${targets.length} → ${MAX_FORWARD_TARGETS_PER_MESSAGE} (msg ${src.messageId})`);
    targets = targets.slice(0, MAX_FORWARD_TARGETS_PER_MESSAGE);
  }
  for (const raw of targets) {
    const target = raw.trim().toLowerCase();
    try {
      if (!(await isForwardTargetAllowed(env, src.userId, userEmail, target))) continue;
      // 去重佔位：PK 衝突→changes=0→已轉過→跳過。先佔位再排程＝at-most-once。
      const now = Date.now();
      const dedup = await env.DB.prepare(
        `INSERT OR IGNORE INTO forwarded_log (user_id, message_id, target, created_at) VALUES (?, ?, ?, ?)`,
      )
        .bind(src.userId, src.messageId, target, now)
        .run();
      if (!dedup.meta.changes) continue;

      // F11：核發本封外寄的迴圈斷點 marker（隨機、不含任何內部 id → 不對外洩漏 msg_ 編號）。
      // 先寫表再排程：寫不進去就不排程這個目標（沿用 at-most-once「寧可漏轉」的取捨），
      // 絕不寄出一封沒有可查驗斷點的轉寄信。
      const marker = randomToken();
      await env.DB.prepare(
        `INSERT INTO forward_markers (marker, user_id, message_id, created_at) VALUES (?, ?, ?, ?)`,
      )
        .bind(marker, src.userId, src.messageId, now)
        .run();

      const subject = (/^fwd:/i.test(src.subject) ? src.subject : `Fwd: ${src.subject}`).slice(0, 990);
      const meta = `寄件者：${src.fromName || src.fromAddr} <${src.fromAddr}>\n主旨：${src.subject || '(無主旨)'}`;
      const payload = {
        to: [target],
        cc: [],
        bcc: [],
        subject,
        text: `---------- 自動轉寄郵件 ----------\n${meta}\n\n${src.text}`,
        html: `<p style="color:#888;font-size:13px">---------- 自動轉寄郵件 ----------<br>寄件者：${esc(src.fromName || src.fromAddr)} &lt;${esc(src.fromAddr)}&gt;<br>主旨：${esc(src.subject || '(無主旨)')}</p><hr>${src.html}`,
        attachmentIds: [],
        inReplyTo: null,
        references: null,
        replyToMessageId: null,
        fromAlias: null,
        forwarded: true, // 斷迴圈：此外寄落地時不再觸發轉寄規則
        forwardMarker: marker, // F11：外寄 X-Miseroda-Forwarded 的值（可查驗，取代固定值 '1'）
      };
      const sqId = newId('snd');
      await env.DB.prepare(
        `INSERT INTO send_queue (id, user_id, payload, status, scheduled_at, created_at) VALUES (?, ?, ?, 'scheduled', ?, ?)`,
      )
        .bind(sqId, src.userId, JSON.stringify(payload), now, now)
        .run();
      await env.SEND_QUEUE.send({ kind: 'send', sendQueueId: sqId } satisfies SendJob);
      await audit(env.DB, {
        userId: src.userId,
        action: 'rule.forward',
        targetType: 'message',
        targetId: src.messageId,
        meta: { target, subject: src.subject },
      });
    } catch (err) {
      console.error('forward enqueue failed', target, err); // best-effort：吞錯，不阻斷收信
    }
  }
}
