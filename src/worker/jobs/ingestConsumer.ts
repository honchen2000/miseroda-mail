// ingest 後處理（queue consumer）：消毒 HTML → R2、FTS 索引、規則引擎
// 冪等：KV processed 鍵 + FTS INSERT OR REPLACE，重複投遞安全。
import PostalMime, { type Email } from 'postal-mime';
import { htmlToText, sanitizeEmailHtml, textToHtml } from '../email/sanitize';
import { generateAutoDraft, looksNeedsReply } from '../lib/autoDraft';
import { extractReceiptCard, looksLikeReceipt } from '../lib/receiptCard';
import { applyRules, applyAiCategoryRules, authVerdictField, userHasAiCategoryRule } from '../email/rulesEngine';
import { aiCategorize } from '../api/ai';
import { maybeVacationReply } from '../email/deliver';
import { enqueueForwards, hasSystemForwardMarker } from '../email/forward';
import { r2HtmlKey, r2RawKey } from '../lib/keys';
import { logError } from '../lib/logError';
import { inboxUnreadCount, notifyUser } from '../lib/notify';
import type { IngestJob } from './types';

const FTS_BODY_CAP = 100_000;

/**
 * F18.1：消毒失敗的退路——純文字版＋頂端提示。
 * 不另加 DB 欄位（那要 migration）：標示直接寫進退路 HTML，使用者看得到、error_log 也查得到。
 * textToHtml 會 escape 內容；提示本身是固定字串、無使用者輸入。
 */
export function degradedBody(text: string | undefined): { html: string; hasRemoteImages: boolean } {
  const notice =
    '<p style="margin:0 0 12px;padding:8px 12px;border:1px solid #f0c36d;background:#fff8e1;color:#7a5b00;font-size:13px">' +
    '⚠ 這封信的 HTML 無法安全解析，以下改以純文字顯示（原始檔仍可從「下載原始信件」取得）。</p>';
  return { html: notice + textToHtml(text?.trim() ? text : '（這封信沒有可顯示的純文字內容）'), hasRemoteImages: false };
}

interface MsgRow {
  id: string;
  user_id: string;
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  folder: string;
}

export async function processIngestJob(env: Env, job: IngestJob): Promise<void> {
  const processedKey = `processed:${job.messageId}`;
  if (await env.KV.get(processedKey)) return;

  const msg = await env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND user_id = ?`)
    .bind(job.messageId, job.userId)
    .first<MsgRow>();
  if (!msg) return; // 已被刪除等情況：直接視為完成

  const rawObj = await env.MAIL_STORE.get(r2RawKey(job.userId, job.messageId));
  if (!rawObj) return;
  // F18.1：MIME 解析失敗不再讓整個 job 丟例外——那條路是「重試 5 次 → DLQ → r2_html_key 永遠不回填 →
  // 前端永遠顯示『處理中』」。postal-mime 對 7 種壞輸入實測都不丟例外（2026-09-20），這層是最後保險。
  let parsed: Email;
  try {
    parsed = await PostalMime.parse(await rawObj.arrayBuffer());
  } catch (err) {
    await logError(env, 'ingest.parse', err, { messageId: job.messageId });
    parsed = { headers: [], attachments: [] } as unknown as Email; // 下方全部走 ?. 與純文字退路
  }

  // from_addr 對帳：顯示用寄件者應取自 From: 標頭而非信封寄件者（VERP 退信位址）。
  // 正常新信 handler 已寫對 → no-op；舊信或 handler 寫成 envelope 的列，重跑 ingest 在此自癒（同時下方 FTS/通知/回信沿用）。
  const headerFrom = parsed.from?.address?.toLowerCase();
  if (headerFrom && headerFrom !== msg.from_addr) {
    await env.DB.prepare(`UPDATE messages SET from_addr = ? WHERE id = ?`).bind(headerFrom, job.messageId).run();
    msg.from_addr = headerFrom;
  }

  // cid → 授權 inline proxy URL（同源 iframe 內 <img> 會帶 cookie）
  const atts = await env.DB.prepare(
    `SELECT id, content_id FROM attachments WHERE message_id = ?`,
  )
    .bind(job.messageId)
    .all<{ id: string; content_id: string | null }>();
  const cidMap = new Map<string, string>();
  for (const a of atts.results) {
    if (a.content_id) cidMap.set(a.content_id.replace(/[<>]/g, ''), `/api/v1/attachments/${a.id}/inline`);
  }

  const sourceHtml = parsed.html ?? textToHtml(parsed.text ?? '');
  // F18.1：消毒失敗退回純文字並誠實標示，而不是讓 job 爆掉（同上：爆掉的下場是永遠「處理中」）。
  let html: string;
  let hasRemoteImages: boolean;
  try {
    ({ html, hasRemoteImages } = await sanitizeEmailHtml(sourceHtml, cidMap));
  } catch (err) {
    await logError(env, 'ingest.sanitize', err, { messageId: job.messageId });
    ({ html, hasRemoteImages } = degradedBody(parsed.text));
  }
  await env.MAIL_STORE.put(r2HtmlKey(job.userId, job.messageId), html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });

  // 信件純文字（轉寄用原文、snippet 等共用）——保持乾淨，不含附件內文。
  const bodyText = (parsed.text?.trim() ? parsed.text : await htmlToText(html)).slice(0, FTS_BODY_CAP);
  // FTS（第二顆 D1）：msg_map 取 rowid，INSERT OR REPLACE 冪等。
  // F4.2b：FTS body 額外納入 text/plain 等純文字附件內文（讓附件內容可搜；PDF/二進位待議）。
  //        用獨立 ftsBody，不污染 bodyText（F4.1b 轉寄會用 bodyText 當原文）。
  let ftsBody = bodyText;
  try {
    for (const att of parsed.attachments ?? []) {
      if (ftsBody.length >= FTS_BODY_CAP) break;
      const mime = (att.mimeType ?? '').toLowerCase();
      if (!mime.startsWith('text/') || mime === 'text/html') continue; // text/html 附件略過（避標籤雜訊）；PDF 待議
      const txt = typeof att.content === 'string' ? att.content : new TextDecoder().decode(att.content);
      if (txt.trim()) ftsBody += `\n\n[附件：${att.filename ?? 'text'}]\n${txt}`;
    }
  } catch (err) {
    console.error('attachment text index failed', err); // best-effort：不阻斷收信/索引
  }
  ftsBody = ftsBody.slice(0, FTS_BODY_CAP);
  await env.DB_FTS.prepare(`INSERT OR IGNORE INTO msg_map (message_id, user_id) VALUES (?, ?)`)
    .bind(job.messageId, job.userId)
    .run();
  const mapRow = await env.DB_FTS.prepare(`SELECT fts_rowid FROM msg_map WHERE message_id = ?`)
    .bind(job.messageId)
    .first<{ fts_rowid: number }>();
  if (mapRow) {
    await env.DB_FTS.prepare(
      `INSERT OR REPLACE INTO messages_fts (rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(mapRow.fts_rowid, msg.subject, `${msg.from_name} ${msg.from_addr}`, msg.snippet, ftsBody)
      .run();
  }

  const headerKeys = new Set((parsed.headers ?? []).map((h) => h.key));
  // F2.8a：寄件驗證等級（auth_verdict 已於落信 INSERT 寫入 msg）→ 供 authVerdict 規則第一趟即評估
  const verdict = authVerdictField((msg as { auth_verdict?: string | null }).auth_verdict);
  // F4.1a：第一趟可能於某 priority 觸發 stopProcessing → 帶進第二趟（AI 分類）跳過更低優先序規則。
  // F4.1b：此封自身若帶 X-Miseroda-Forwarded（是規則轉寄產生的外寄又落回）→ isForwarded → 不再收集 forward 目標（斷迴圈）。
  // F11：標頭「有沒有」不算數——遠端寄件者自己寫一行 X-Miseroda-Forwarded 就能關掉收件人的轉寄規則。
  //      改成看「值」是不是本系統核發的 marker（forward_markers 查表，全站有效、不分使用者）。
  const isForwarded = await hasSystemForwardMarker(
    env,
    (parsed.headers ?? []).filter((h) => h.key === 'x-miseroda-forwarded').map((h) => h.value),
  );
  const { stopPriority: stopAtPriority, forwardTargets } = await applyRules(
    env,
    { ...msg, to_addrs: (msg as { to_addrs?: string }).to_addrs },
    { hasListUnsubscribe: headerKeys.has('list-unsubscribe'), firstInsert: true, authVerdict: verdict, isForwarded },
  );

  await env.DB.prepare(`UPDATE messages SET r2_html_key = ?, remote_images = ? WHERE id = ?`)
    .bind(r2HtmlKey(job.userId, job.messageId), hasRemoteImages ? 1 : 0, job.messageId)
    .run();

  // F4.1b：命中轉寄規則 → 以本人身分排程外寄（限聯絡人/站內、去重 at-most-once）。只在有目標時才查 userEmail（常路徑零成本）。
  if (forwardTargets.length) {
    const ue = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(job.userId).first<{ email: string }>();
    if (ue) {
      await enqueueForwards(
        env,
        {
          userId: job.userId,
          userEmail: ue.email,
          messageId: job.messageId,
          fromAddr: msg.from_addr,
          fromName: msg.from_name,
          subject: msg.subject,
          html,
          text: bodyText,
        },
        forwardTargets,
      );
    }
  }

  // F2.8b：已退訂的寄件者又寄來 → 自動歸檔 + 標記（在通知決策「之前」執行，已歸檔者不推播）。
  // 只在仍於 inbox 時動（尊重既有規則已搬移的結果，且重跑冪等）。best-effort：失敗不阻斷收信。
  try {
    const unsubbed = await env.DB.prepare(`SELECT 1 FROM unsubscribed_senders WHERE user_id = ? AND sender = ?`)
      .bind(job.userId, msg.from_addr.toLowerCase())
      .first();
    if (unsubbed) {
      await env.DB.prepare(`UPDATE messages SET folder = 'archive', unsub_resend = 1 WHERE id = ? AND user_id = ? AND folder = 'inbox'`)
        .bind(job.messageId, job.userId)
        .run();
    }
  } catch (err) {
    console.error('unsub re-send archive failed', err);
  }

  // F5.3：寄件者首見審核閘（收窄版，Hon 決策「只擋驗證未過的陌生人」）——「陌生人首觸 且 寄件驗證為 partial」
  // → 標 screening=1（仍在 inbox 但歸待審夾：不顯示於收件匣、不算未讀、不推播）。
  // 驗證等級分流（避免誤擋／over-hold）：
  //   pass    → 收件匣（已驗證，不擋）
  //   fail    → 落信即被 looksSpam 歸 spam（folder!='inbox'，本閘 folder='inbox' 守門天然略過）
  //   none    → 收件匣（完全無 Authentication-Results＝未被評估，無「未過」訊號，給予 benefit-of-doubt，不 over-hold）
  //   partial → 待審（已被評估但 SPF/DKIM 對齊不一致＝真正「驗了但沒過」的陌生首觸訊號）
  // 只在仍 inbox 且未標時動（UPDATE 守門 → 尊重規則/unsub/spam 已搬移、重跑冪等）。best-effort：失敗不阻斷收信。
  try {
    const sender = msg.from_addr.toLowerCase();
    if (verdict === 'partial' && !sender.endsWith(`@${env.MAIL_DOMAIN.toLowerCase()}`)) {
      // 陌生＝非手動聯絡人 且 無往來（排除本封、spam/trash 不算往來；screening 中的往來不算「已認識」）。
      const known = await env.DB.prepare(
        `SELECT 1 FROM contacts WHERE user_id = ?1 AND lower(email) = ?2
         UNION SELECT 1 FROM messages WHERE user_id = ?1 AND id != ?3 AND folder NOT IN ('spam','trash') AND screening = 0
           AND ( (direction = 'inbound' AND lower(from_addr) = ?2)
              OR (direction = 'outbound' AND EXISTS (SELECT 1 FROM json_each(to_addrs) je WHERE lower(je.value) = ?2)) )
         LIMIT 1`,
      )
        .bind(job.userId, sender, job.messageId)
        .first();
      if (!known) {
        // F9.5：Speakeasy 暗號——把暗號告訴對方，主旨帶暗號的陌生來信直接放行（不進待審）。
        // 大小寫不敏感；暗號至少 4 字（API 驗證下限，這裡再守一次，避免短碼誤放行）。
        const sk = await env.DB.prepare(`SELECT json_extract(prefs, '$.speakeasy') AS code FROM user_settings WHERE user_id = ?`)
          .bind(job.userId)
          .first<{ code: string | null }>();
        const code = typeof sk?.code === 'string' ? sk.code.trim() : '';
        const hasCode = code.length >= 4 && msg.subject.toLowerCase().includes(code.toLowerCase());
        if (!hasCode) {
          await env.DB.prepare(`UPDATE messages SET screening = 1 WHERE id = ? AND user_id = ? AND folder = 'inbox' AND screening = 0`)
            .bind(job.messageId, job.userId)
            .run();
        }
      }
    }
  } catch (err) {
    console.error('screener gate failed', err);
  }

  // 假期自動回覆（清單信/自動信不回；垃圾信不回）
  if (msg.folder !== 'spam') {
    const isBulk =
      headerKeys.has('list-unsubscribe') ||
      headerKeys.has('list-id') ||
      headerKeys.has('auto-submitted') ||
      (parsed.headers ?? []).some((h) => h.key === 'precedence' && /bulk|list|junk/i.test(h.value));
    await maybeVacationReply(env, {
      recipientUserId: job.userId,
      senderAddr: msg.from_addr,
      subject: msg.subject,
      isBulk,
    });
  }

  // 即時通知：WS 一律刷新；系統推播只給留在收件匣的信（規則歸檔/垃圾信/待審不吵人）
  const after = await env.DB.prepare(`SELECT folder, ai_category, screening FROM messages WHERE id = ?`)
    .bind(job.messageId)
    .first<{ folder: string; ai_category: string | null; screening: number }>();
  const inInbox = after?.folder === 'inbox' && after.screening === 0; // F5.3：待審信(screening=1)不推播、不分類
  await notifyUser(env, job.userId, {
    type: 'new-mail',
    push:
      inInbox
        ? {
            title: msg.from_name || msg.from_addr,
            body: msg.subject || '(無主旨)',
            url: `/#msg-${job.messageId}`,
            id: job.messageId, // SW 通知 tag + 封存/已讀動作目標
            unread: await inboxUnreadCount(env, job.userId), // SW 背景設 OS 角標（計數失敗回 undefined，不影響收信）
          }
        : undefined,
  });

  // 收信主流程（落地+索引+規則+通知）已完成 → 先標記 processed，避免接下來「best-effort 的 AI 分類」
  // 若逾時/被中斷，反而讓整個 job 重跑（重複套規則/通知）。AI 分類純加分，失敗不影響收信。
  await env.KV.put(processedKey, '1', { expirationTtl: 7 * 86400 });

  // F2.2b：規則用 AI 分類當條件。成本守門——只有使用者「有 ai_category 規則」、信留在收件匣、且尚未分類過才跑。
  // aiCategorize throw-safe（失敗回 null）；整段 try/catch 不阻斷收信；ai_category 已存在則跳過（重跑冪等）。
  try {
    if (inInbox && after.ai_category == null && (await userHasAiCategoryRule(env, job.userId))) {
      const category = await aiCategorize(env, {
        fromName: msg.from_name,
        fromAddr: msg.from_addr,
        subject: msg.subject,
        snippet: msg.snippet,
      });
      if (category) {
        await env.DB.prepare(`UPDATE messages SET ai_category = ? WHERE id = ? AND user_id = ?`)
          .bind(category, job.messageId, job.userId)
          .run();
        await applyAiCategoryRules(
          env,
          { ...msg, folder: 'inbox', to_addrs: (msg as { to_addrs?: string }).to_addrs },
          { hasListUnsubscribe: headerKeys.has('list-unsubscribe'), firstInsert: true, authVerdict: verdict, stopAtPriority },
          category,
        );
      }
    }
  } catch (err) {
    await logError(env, 'ingest.categorize', err, { messageId: job.messageId }); // F12.2
  }

  // F10.2：抵達即備稿——「像在等你回覆」的私人信（窄判定：非批量/非 noreply/含問句請求標記）
  // 背景生成回覆草稿存 KV 7 天，讀信時即現。prefs.autoDrafts=false 可關（預設開）。best-effort。
  try {
    if (
      inInbox &&
      looksNeedsReply({
        direction: (msg as { direction?: string }).direction ?? '',
        listUnsubscribe: (msg as { list_unsubscribe?: string | null }).list_unsubscribe ?? null,
        fromAddr: msg.from_addr,
        subject: msg.subject,
        body: bodyText,
      })
    ) {
      const pref = await env.DB.prepare(`SELECT json_extract(prefs, '$.autoDrafts') AS v FROM user_settings WHERE user_id = ?`)
        .bind(job.userId)
        .first<{ v: number | null }>();
      if (pref?.v !== 0) {
        await generateAutoDraft(env, {
          userId: job.userId,
          messageId: job.messageId,
          fromName: msg.from_name || msg.from_addr,
          subject: msg.subject,
          body: bodyText,
        });
      }
    }
  } catch (err) {
    console.error('auto draft gate failed', err);
  }

  // F10.3：收據/帳單/出貨信 → AI 抽結構卡片（金額/到期/追蹤號）存 receipt_card。
  // 只對主旨命中 receipt lane 的入站信抽（窄成本）；清洗後全空不存。best-effort。
  try {
    const dir = (msg as { direction?: string }).direction ?? '';
    if (dir === 'inbound' && after && after.folder !== 'spam' && after.folder !== 'trash' && looksLikeReceipt(msg.subject)) {
      const card = await extractReceiptCard(env, { subject: msg.subject, fromName: msg.from_name || msg.from_addr, body: bodyText });
      if (card) {
        await env.DB.prepare(`UPDATE messages SET receipt_card = ? WHERE id = ? AND user_id = ?`)
          .bind(JSON.stringify(card), job.messageId, job.userId)
          .run();
      }
    }
  } catch (err) {
    console.error('receipt card gate failed', err);
  }
}
