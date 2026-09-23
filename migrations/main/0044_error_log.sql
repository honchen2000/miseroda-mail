-- F12.2：錯誤 ring buffer——高價值 catch 點的真錯誤集中記錄，admin 系統頁檢視。
-- 環形保留（sweep 清最近 500 筆外的）；純加法建表，無 trigger。
CREATE TABLE IF NOT EXISTS error_log (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,       -- 來源標記（如 send.persist / ingest.categorize / sweep.retention）
  message     TEXT NOT NULL,       -- 錯誤訊息（截斷）
  meta        TEXT,                -- 選填 JSON 上下文（如 messageId/userId）
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_created ON error_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_scope ON error_log(scope, created_at DESC);
