// 每日 AI 晨報：彙整過去 24h 未讀，生成一封信直接放進收件匣
// （不經 SEND_EMAIL，避免寄給自己造成 ingest 迴圈 + 省額度）
import { AI_MODEL } from '../api/ai';
import { newId } from '../lib/ids';
import { r2HtmlKey } from '../lib/keys';
import { inboxUnreadCount, notifyUser } from '../lib/notify';
import { buildAgenda, taipeiDayWindow } from '../lib/agenda';
import { audit } from '../lib/audit';

interface DigestUser {
  id: string;
  email: string;
  prefs: string;
}

interface UnreadRow {
  from_name: string;
  from_addr: string;
  subject: string;
  snippet: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function runDailyDigest(env: Env): Promise<void> {
  const since = Date.now() - 24 * 3600_000;
  const users = await env.DB.prepare(
    `SELECT u.id, u.email, us.prefs FROM users u JOIN user_settings us ON us.user_id = u.id
     WHERE u.status = 'active'`,
  ).all<DigestUser>();

  for (const u of users.results) {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(u.prefs) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    if (!prefs.dailyDigest) continue;

    const unread = await env.DB.prepare(
      `SELECT from_name, from_addr, subject, snippet FROM messages
       WHERE user_id = ? AND folder = 'inbox' AND is_read = 0 AND screening = 0 AND received_at > ?
         AND (snoozed_until IS NULL OR snoozed_until <= ?)
       ORDER BY received_at DESC LIMIT 20`,
    )
      .bind(u.id, since, Date.now())
      .all<UnreadRow>();
    if (!unread.results.length) continue;

    const n = unread.results.length;
    const listText = unread.results
      .map((m, i) => `${i + 1}. ${m.from_name || m.from_addr}：${m.subject}（${m.snippet.slice(0, 40)}）`)
      .join('\n');

    // AI 開場白（失敗則略過，仍出晨報）
    let intro = '';
    try {
      const res = (await env.AI.run(AI_MODEL, {
        messages: [
          { role: 'system', content: '你是貼心的信件助理 Pori。用 1 句繁體中文總結今天的未讀重點，溫暖簡短，可用一個 emoji。只輸出那句話。' },
          { role: 'user', content: listText },
        ],
      } as never)) as { response?: unknown };
      if (typeof res.response === 'string') intro = res.response.trim().slice(0, 200);
    } catch {
      /* 略過 */
    }

    const messageId = newId('msg');
    const threadId = newId('thr');
    const now = Date.now();
    // 今日聚合摘要（會議 / 待跟進）：插在未讀清單前，讓晨報不只講未讀。
    // .catch([]) ：聚合失敗絕不可中斷整個 digest 迴圈（會害到後續使用者，同 F1.3 教訓）。
    const { from: dayFrom, to: dayTo } = taipeiDayWindow(now);
    const agenda = await buildAgenda(env, u.id, dayFrom, dayTo).catch(() => []);
    const evCount = agenda.filter((a) => a.kind === 'event').length;
    const fuCount = agenda.filter((a) => a.kind === 'followup').length;
    const agendaParts: string[] = [];
    if (evCount) agendaParts.push(`${evCount} 場會議`);
    if (fuCount) agendaParts.push(`${fuCount} 件待跟進`);
    const agendaHtml = agendaParts.length
      ? `<p style="color:#7A88FF;font-size:14px;margin:0 0 12px">📅 今日 ${agendaParts.join(' · ')}</p>`
      : '';
    const itemsHtml = unread.results
      .map(
        (m) =>
          `<li style="margin:0 0 8px"><strong>${escapeHtml(m.from_name || m.from_addr)}</strong> — ${escapeHtml(m.subject || '（無主旨）')}<br><span style="color:#9FB0CC;font-size:13px">${escapeHtml(m.snippet.slice(0, 80))}</span></li>`,
      )
      .join('');
    const html = `<div><p>🐧 早安！${intro ? escapeHtml(intro) : `你有 ${n} 封未讀信件。`}</p>${agendaHtml}<ul style="padding-left:18px">${itemsHtml}</ul><p style="color:#6B7A99;font-size:12px">這是 Miseroda Mail 自動晨報。可在「設定 → 通知」關閉。</p></div>`;
    const snippet = intro || `今日 ${n} 封未讀`;

    await env.MAIL_STORE.put(r2HtmlKey(u.id, messageId), html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO threads (id, user_id, subject, last_message_at, message_count) VALUES (?, ?, ?, ?, 1)`,
      ).bind(threadId, u.id, `今日晨報 · ${n} 封未讀`, now),
      env.DB.prepare(
        `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs,
          subject, snippet, r2_html_key, folder, is_read, received_at, created_at)
         VALUES (?, ?, ?, 'inbound', 'digest@miseroda.com', 'Miseroda 晨報', ?, ?, ?, ?, 'inbox', 0, ?, ?)`,
      ).bind(
        messageId,
        u.id,
        threadId,
        JSON.stringify([u.email]),
        `今日晨報 · ${n} 封未讀`,
        snippet,
        r2HtmlKey(u.id, messageId),
        now,
        now,
      ),
    ]);
    await audit(env.DB, { userId: u.id, action: 'digest.create', targetType: 'message', targetId: messageId, meta: { unread: n } });
    await notifyUser(env, u.id, {
      type: 'new-mail',
      push: {
        title: 'Miseroda 晨報',
        body: `今日 ${n} 封未讀，AI 重點整理好了`,
        url: `/#msg-${messageId}`,
        id: messageId, // SW 通知 tag（晨報自成一則）+ 封存/已讀動作目標
        unread: await inboxUnreadCount(env, u.id), // 含剛插入的晨報信，SW 設角標
      },
    });
  }
}
