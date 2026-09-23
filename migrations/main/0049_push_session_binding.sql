-- F5：把 Web Push 訂閱綁到「建立它的那個 session」。
-- 推播內容帶寄件者與主旨 → 授權必須隨 session 一起結束；否則登出／撤銷 session／停用帳號之後，
-- 那台已被取消授權的瀏覽器仍會為每封新信跳出寄件者＋主旨的系統通知。
-- 純加法：既有列 session_id 為 NULL（＝ 0049 之前建立的舊訂閱），推送端刻意仍放行它們，
-- 避免升級當下讓所有仍登入中的裝置無聲斷掉通知；這些舊列會在該裝置下次開 App
-- （reaffirmPushSubscription → /push/subscribe upsert）時自動補上綁定，
-- 或在登出（前端 /push/unsubscribe 本機 endpoint）／撤銷全部 session／停用帳號時被刪除。
ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT;

-- 撤銷路徑用 (user_id, session_id) 刪列；user_id 已有 idx_push_user，這裡補 session_id 的查找。
CREATE INDEX IF NOT EXISTS idx_push_session ON push_subscriptions(session_id);
