// email() handler：守門 → R2 raw → postal-mime → D1 中繼資料 + thread → 丟 INGEST_QUEUE
// 消毒 / FTS / 規則引擎在 queue consumer 非同步處理，這裡保持精瘦。
import PostalMime, { type Email } from 'postal-mime';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import { r2AttKey, r2CalKey, r2RawKey } from '../lib/keys';
import { bumpThread, resolveThread } from './threading';
import { parseIcs, type CalendarEvent } from './calendar';
import { cancelCalendarEvent, upsertCalendarEvent } from './calendarStore';
import { parseListUnsubscribe } from './list-unsubscribe';
import { categorizeMessage } from './categorize';
import { parseAuthVerdict } from './authVerdict';
import { scoreInbound } from './spamTrain';
import type { IngestJob } from '../jobs/types';

const MAX_INBOUND_BYTES = 25 * 1024 * 1024; // Email Routing 平台上限

const SNIPPET_LEN = 140;

// 去標籤取 snippet：語意等同舊寫法 html.replace(/<[^>]+>/g, ' ')，但改成單次前掃。
// 舊 regex 對「大量 '<' 而無 '>'」的來信 HTML（最大 25 MiB，完全由寄件者控制）會二次方回溯，
// 足以燒掉 email() 的 CPU 額度（CWE-1333）；這裡每個字元最多看一次。
// 刻意保留原 regex 的邊界語意：'<>' 不算標籤（[^>]+ 至少要一個字元）、'<' 找不到對應的 '>' 時原樣保留。
// 空白壓縮邊掃邊做，湊滿 SNIPPET_LEN 個可見字元即收工（後面的內容影響不到前 SNIPPET_LEN 字）。
function stripTagsForSnippet(html: string): string {
  let out = ''; // 已壓縮空白、無前導空白、無連續空白
  const push = (piece: string) => {
    if (!piece) return;
    const collapsed = piece.replace(/\s+/g, ' ');
    out += out === '' || out.endsWith(' ') ? collapsed.replace(/^ /, '') : collapsed;
  };
  let i = 0;
  while (i < html.length && out.length <= SNIPPET_LEN) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      push(html.slice(i));
      break;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      push(html.slice(i)); // 沒有收尾的 '>' → 剩下的都不是標籤，原樣保留
      break;
    }
    if (gt === lt + 1) {
      push(html.slice(i, gt)); // '<>' 不是標籤：'<' 原樣留下，從 '>' 繼續掃
      i = gt;
      continue;
    }
    push(html.slice(i, lt));
    push(' '); // 標籤本身換成一個空白
    i = gt + 1;
  }
  return out;
}

export function makeSnippet(text: string | undefined, html: string | undefined): string {
  if (text && text.trim()) return text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN);
  return stripTagsForSnippet(html ?? '').trim().slice(0, SNIPPET_LEN);
}

function collectAuthResults(message: ForwardableEmailMessage, parsed: Email): string {
  const parts: string[] = [];
  const fromRuntime = message.headers.get('authentication-results');
  if (fromRuntime) parts.push(fromRuntime);
  for (const h of parsed.headers ?? []) {
    if (h.key === 'authentication-results') parts.push(h.value);
  }
  return parts.join(' ; ').toLowerCase();
}

function looksSpam(authResults: string): boolean {
  if (/dmarc=fail/.test(authResults)) return true;
  if (/spf=(fail|softfail)/.test(authResults) && /dkim=fail/.test(authResults)) return true;
  return false;
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // 收件人解析（plus-addressing：user+tag@ → user@）
  const rcpt = (message.to ?? '').toLowerCase();
  const local = rcpt.split('@')[0]?.split('+')[0] ?? '';
  const canonical = `${local}@${env.MAIL_DOMAIN}`;
  let user = await env.DB.prepare(`SELECT id FROM users WHERE email = ? AND status = 'active'`)
    .bind(canonical)
    .first<{ id: string }>();

  // 乾淨網域別名：canonical 不是任何使用者 email → 查別名表路由到擁有者（plus-addressing 已正規化 +tag）。
  if (!user) {
    const alias = await env.DB.prepare(
      `SELECT u.id AS user_id, a.disabled FROM aliases a JOIN users u ON u.id = a.user_id
       WHERE a.address = ? AND u.status = 'active'`,
    )
      .bind(canonical)
      .first<{ user_id: string; disabled: number }>();
    if (alias) {
      // F9.4：停用中的別名對外表現如「查無此人」——在 FORWARD_TO 過渡轉寄之前就拒收，
      // 否則停用別名的信會外洩到過渡信箱。
      if (alias.disabled) {
        message.setReject('No such recipient');
        return;
      }
      user = { id: alias.user_id };
    }
  }

  if (!user) {
    // 切換過渡期（M7）：未知收件人照舊轉寄到既有信箱；平時直接拒收
    if (env.FORWARD_TO) {
      await message.forward(env.FORWARD_TO);
      return;
    }
    message.setReject('No such recipient');
    return;
  }

  if (message.rawSize > MAX_INBOUND_BYTES) {
    message.setReject('Message too large');
    return;
  }

  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const parsed = await PostalMime.parse(raw);

  const messageId = newId('msg');
  const now = Date.now();

  await env.MAIL_STORE.put(r2RawKey(user.id, messageId), raw);

  // 附件：R2 實體 + D1 列。text/calendar（會議邀請）另外處理成邀請卡，不存成一般附件。
  const attStmts: D1PreparedStatement[] = [];
  let hasAttachments = 0;
  let calendarEventJson: string | null = null;
  let parsedCalEvent: CalendarEvent | null = null;
  for (const att of parsed.attachments ?? []) {
    if (/text\/calendar/i.test(att.mimeType || '') || /\.ics$/i.test(att.filename || '')) {
      if (!calendarEventJson) {
        const icsText = typeof att.content === 'string' ? att.content : new TextDecoder().decode(att.content);
        const ev = parseIcs(icsText);
        if (ev) {
          calendarEventJson = JSON.stringify(ev);
          parsedCalEvent = ev;
          await env.MAIL_STORE.put(r2CalKey(user.id, messageId), icsText, {
            httpMetadata: { contentType: 'text/calendar; charset=utf-8' },
          });
        }
      }
      continue; // 不存成一般附件
    }
    // related/inline 圖（cid）也存，閱讀時經授權 proxy 內嵌
    const attId = newId('att');
    const bytes =
      typeof att.content === 'string' ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
    await env.MAIL_STORE.put(r2AttKey(user.id, messageId, attId), bytes, {
      httpMetadata: { contentType: att.mimeType || 'application/octet-stream' },
    });
    if (att.disposition !== 'inline' || !att.contentId) hasAttachments = 1;
    attStmts.push(
      env.DB.prepare(
        `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, content_id, r2_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        attId,
        messageId,
        user.id,
        att.filename || 'attachment',
        att.mimeType || 'application/octet-stream',
        bytes.byteLength,
        att.disposition ?? null,
        att.contentId ?? null,
        r2AttKey(user.id, messageId, attId),
        now,
      ),
    );
  }

  const authResults = collectAuthResults(message, parsed);
  const isSpamAuth = looksSpam(authResults);
  // 寄件者信任卡：保存 SPF/DKIM/DMARC 結果（先前只用來判垃圾信、用完即丟）。
  // 安全：verdict 只認「邊界 MTA（Cloudflare）加的那一份」A-R——runtime 標頭優先，否則取 raw 中最上方（最新一跳）那筆。
  // 不用 collectAuthResults 的「runtime+所有 MIME 內 A-R」合併字串，避免寄件者在信體內偽造第二份 A-R 灌 pass 騙過信任徽章。
  const trustedAr =
    message.headers.get('authentication-results') ??
    (parsed.headers ?? []).find((h) => h.key === 'authentication-results')?.value ??
    '';
  const authVerdict = parseAuthVerdict(trustedAr.toLowerCase());
  const authVerdictJson = authVerdict ? JSON.stringify(authVerdict) : null;

  // 一鍵退訂：List-Unsubscribe / List-Unsubscribe-Post 標頭
  const hdr = (k: string): string | null =>
    message.headers.get(k) ?? (parsed.headers ?? []).find((h) => h.key === k)?.value ?? null;
  const unsub = parseListUnsubscribe(hdr('list-unsubscribe'), hdr('list-unsubscribe-post'));
  const listUnsubJson = unsub ? JSON.stringify(unsub) : null;
  const subject = parsed.subject ?? '';
  const threadId = await resolveThread(env, user.id, {
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    subject,
    timestamp: now,
  });

  const toAddrs = (parsed.to ?? []).map((a) => a.address).filter(Boolean);
  const ccAddrs = (parsed.cc ?? []).map((a) => a.address).filter(Boolean);

  // 顯示用寄件者取自 From: 標頭（與 from_name 同源、回信也寄對人）；
  // message.from 是信封寄件者/Return-Path（常為 provider 的 VERP 退信位址，非給人看的），僅當 From 標頭缺漏時 fallback。
  const fromAddr = (parsed.from?.address ?? message.from).toLowerCase();
  // 收件匣分類（主要/社交/促銷/通知）：確定性啟發式，無 AI 成本。NULL 等同 primary，故 spam 不分也無妨。
  const category = categorizeMessage({
    fromAddr,
    subject,
    hasListUnsubscribe: !!unsub,
    listId: hdr('list-id'),
    precedence: hdr('precedence'),
    autoSubmitted: hdr('auto-submitted'),
  });

  // 垃圾判定：SPF/DKIM/DMARC 閘門（isSpamAuth）+ 每使用者貝氏分類器（訓練量足夠且高機率才判，保守不誤殺）。
  const snippet = makeSnippet(parsed.text, parsed.html ?? undefined);
  const isSpam = isSpamAuth || (await scoreInbound(env, user.id, subject, snippet));

  // 靜音對話串：muted thread 的新信跳過收件匣（進封存）並標已讀；spam 仍優先進垃圾信。
  const threadMuted =
    (await env.DB.prepare(`SELECT muted FROM threads WHERE id = ?`).bind(threadId).first<{ muted: number }>())?.muted === 1;
  const folder = isSpam ? 'spam' : threadMuted ? 'archive' : 'inbox';
  const isReadFlag = !isSpam && threadMuted ? 1 : 0;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, message_id_header, in_reply_to, references_header,
        direction, from_addr, from_name, to_addrs, cc_addrs, subject, snippet, r2_raw_key,
        size_bytes, has_attachments, is_read, folder, calendar_event, list_unsubscribe, category, auth_verdict, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      messageId,
      user.id,
      threadId,
      parsed.messageId ?? null,
      parsed.inReplyTo ?? null,
      parsed.references ?? null,
      fromAddr,
      parsed.from?.name ?? '',
      JSON.stringify(toAddrs),
      JSON.stringify(ccAddrs),
      subject,
      snippet,
      r2RawKey(user.id, messageId),
      message.rawSize,
      hasAttachments,
      isReadFlag,
      folder,
      calendarEventJson,
      listUnsubJson,
      category,
      authVerdictJson,
      now,
      now,
    ),
    ...attStmts,
  ]);
  await bumpThread(env, threadId, now);

  // 行事曆事件：REQUEST/一般邀請 → 入行事曆；CANCEL → 移除（垃圾信不入行事曆）
  if (parsedCalEvent?.uid && !isSpam) {
    // F16.2：CANCEL 不再直接刪除——通過授權者標「待確認取消」由使用者確認，未通過者完全不動事件。
    if (parsedCalEvent.method === 'CANCEL') await cancelCalendarEvent(env, user.id, parsedCalEvent.uid, fromAddr);
    // F16.1：授權位址＝這封信的 From。插入時寫死成該列的 auth_addr，日後只有它（或既存 organizer）
    // 改得動這一列；沒帶就等於 fail closed，收到的 .ics 無法更新既有列。
    else await upsertCalendarEvent(env, user.id, parsedCalEvent, { source: 'received', messageId, authAddr: fromAddr });
  }

  if (isSpam) {
    await audit(env.DB, {
      userId: user.id,
      action: 'ingest.spam',
      targetType: 'message',
      targetId: messageId,
      meta: { from: message.from },
    });
  }

  await env.INGEST_QUEUE.send({ kind: 'ingest', messageId, userId: user.id } satisfies IngestJob);

  // 雙投遞過渡（M7）：已知使用者也照舊轉寄一份，直到信心足夠才關閉
  if (env.FORWARD_TO) {
    await message.forward(env.FORWARD_TO);
  }
}
