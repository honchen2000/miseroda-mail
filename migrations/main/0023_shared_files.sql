-- 大附件轉連結：超過內嵌寄信上限（5 MiB）的檔案改存 R2 + 公開下載連結（高熵 token + 到期）。
-- 公開下載端點 GET /dl/:token 一律以 attachment + octet-stream 提供（防同源 XSS）；過期由 cron 清理。
CREATE TABLE IF NOT EXISTS shared_files (
  id             TEXT PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL,
  filename       TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  r2_key         TEXT NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_files_token ON shared_files(token);
CREATE INDEX IF NOT EXISTS idx_shared_files_expires ON shared_files(expires_at);
