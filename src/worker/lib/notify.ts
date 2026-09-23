// 新信通知總管：WebSocket（DO hub）即時刷新 + Web Push 系統通知
import { pushToUser, type PushPayload } from './webpush';

export interface MailEvent {
  type: 'new-mail' | 'refresh' | 'reaction' | 'snooze-wake' | 'security';
  /** 推播內容（new-mail / snooze-wake / security）；不提供則只做 WS 刷新 */
  push?: PushPayload;
}

/**
 * 收件匣未讀數（與 /counts 一致：排除 snoozed），供 Web Push 帶給 SW 設 OS 角標。
 * 計數失敗時回 undefined（不丟例外）→ 推播略過角標即可，**絕不可拖垮收信/晨報主流程**
 * （此函式在 notifyUser 的 try/catch 之外被 await，丟例外會中斷投遞）。
 */
export async function inboxUnreadCount(env: Env, userId: string): Promise<number | undefined> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages
         WHERE user_id = ? AND folder = 'inbox' AND is_read = 0 AND screening = 0
           AND NOT (snoozed_until IS NOT NULL AND snoozed_until > ?)`,
    )
      .bind(userId, Date.now())
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return undefined;
  }
}

/**
 * WS 廣播內容（F21.2/F21.4）。
 *
 * 關鍵語意：**`push` 有值＝這封信留在收件匣、值得吵使用者**；規則自動歸檔、垃圾信、
 * 待審信（screening=1）都是 `push: undefined`（見 ingestConsumer / deliver 的呼叫處）。
 * 前端的提示音與站內卡片必須沿用同一條判準，否則垃圾信也會叮一聲 —— 所以只有帶得出
 * 寄件者的 new-mail 才把 `from`/`subject` 放進廣播，前端看不到 `from` 就只刷新不出聲。
 *
 * 欄位沿用 push payload：`title` 就是寄件者名稱、`body` 就是主旨（推播通知本來就這樣呈現），
 * 不另外在 MailEvent 上開新欄位，避免動到全部呼叫端。
 *
 * 無 push 時輸出與舊版一字不差（`{"type":"new-mail"}`），既有的 WS 測試仍成立。
 */
function wsPayload(event: MailEvent): Record<string, unknown> {
  if (event.type !== 'new-mail' || !event.push) return { type: event.type };
  return { type: event.type, id: event.push.id, from: event.push.title, subject: event.push.body };
}

export async function notifyUser(
  env: Env,
  userId: string,
  event: MailEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // WS：失敗不影響主流程
  try {
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(userId));
    const res = await stub.fetch('https://hub/notify', {
      method: 'POST',
      body: JSON.stringify(wsPayload(event)),
    });
    await res.arrayBuffer(); // 消化回應體（未消化的 body 會卡住 DO 生命週期 / 測試隔離回收）
  } catch (err) {
    console.error('ws notify failed', err);
  }
  if ((event.type === 'new-mail' || event.type === 'snooze-wake' || event.type === 'security') && event.push) {
    try {
      await pushToUser(env, userId, event.push, fetchImpl);
    } catch (err) {
      console.error('push notify failed', err);
    }
  }
}
