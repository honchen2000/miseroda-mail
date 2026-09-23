import { api } from '../api/client';

// App 啟動健康檢查：若本機已有 push 訂閱，重新回報給後端（idempotent upsert）。
// 補上 pushsubscriptionchange 在背景沒處理到 / CSRF 失敗的輪換，確保後端永遠握有目前 endpoint。
// best-effort：任何失敗都安靜吞掉（未登入、不支援、離線）。
export async function reaffirmPushSubscription(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return; // 沒訂閱 → 無事
    const json = sub.toJSON();
    await api('/push/subscribe', {
      method: 'POST',
      body: { endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    });
  } catch {
    /* best-effort */
  }
}

// F5：登出前，趁 session 還有效撤掉「本機這台裝置」的 push 訂閱。
// 為什麼要有它（伺服器端已刪綁本 session 的那列）：0049 之前建立的舊訂閱沒有 session_id，
// 伺服器端的單一 session 撤銷刻意不敢碰它們（會誤刪其他仍登入中裝置的通知）——這裡按 endpoint 精準刪本機這列。
// 刻意不呼叫 sub.unsubscribe()：瀏覽器端訂閱留著，重新登入後 reaffirmPushSubscription 立刻回報恢復推播，
// 使用者不必再去設定頁重開一次開關。
// best-effort：不支援／離線／沒訂閱都安靜跳過，絕不擋住登出（逾時也調短，登出不該卡）。
export async function releasePushSubscription(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    // 用 getRegistration()（不是 ready）：沒註冊 SW 時它會立刻回 undefined，而 ready 會永遠 pending＝卡住登出。
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint }, timeoutMs: 5_000 });
  } catch {
    /* best-effort */
  }
}
