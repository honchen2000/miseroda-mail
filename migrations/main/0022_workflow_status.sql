-- 工作流狀態：需回信 / 等待中 工作區 + 釘選。
-- message_status：NULL（無）/ 'needs_reply'（需回信）/ 'waiting'（等待回覆）—— 互斥的工作流通道，與資料夾/分類正交。
-- pinned_at：NULL（未釘選）/ 時間戳 —— 與 status 正交（可同時釘選又標需回信）。
ALTER TABLE messages ADD COLUMN message_status TEXT;
ALTER TABLE messages ADD COLUMN pinned_at INTEGER;
-- 含排序欄位（received_at DESC, id DESC）以支撐 keyset 游標分頁，比照既有 idx_messages_user_folder。
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(user_id, message_status, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(user_id, pinned_at, received_at DESC, id DESC);
