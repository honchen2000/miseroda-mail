-- Snooze 稍後處理：到期由 cron 清回收件匣
ALTER TABLE messages ADD COLUMN snoozed_until INTEGER;
-- AI 翻譯快取（繁中），與 ai_summary 並列
ALTER TABLE messages ADD COLUMN ai_translation TEXT;
CREATE INDEX idx_messages_snoozed ON messages(user_id, snoozed_until);
