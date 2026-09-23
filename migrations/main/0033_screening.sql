-- F5.3：寄件者首見審核閘（Screener）。screening=1 → 仍在 inbox 但歸「待審夾」（不顯示於收件匣、不算未讀、不推播）。
-- 純加性：新增欄位（既有信預設 0＝正常）、加一個部分索引給待審 lane 查詢。folder 仍受原 CHECK 約束，不動核心表。
ALTER TABLE messages ADD COLUMN screening INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_messages_screening ON messages (user_id, screening) WHERE screening = 1;
