-- 收件匣分類分頁（主要 / 社交 / 促銷 / 通知）：ingest 時以確定性啟發式寫入。
-- NULL（既有信或未分類）在查詢/計數時一律視為 'primary'，故無需立即回填。
ALTER TABLE messages ADD COLUMN category TEXT;
