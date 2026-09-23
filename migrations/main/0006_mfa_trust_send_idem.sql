-- F1：信任裝置（通過 TOTP 後可勾選 30 天內免再驗證；token hash 存庫，比照 sessions）
CREATE TABLE trusted_devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_trusted_user ON trusted_devices(user_id);

-- F4：外送冪等標記。外部 Email Service 寄送成功後即記時間，
-- 使用者手動重寄時據此跳過外送，避免重複寄給外部收件人。
ALTER TABLE send_queue ADD COLUMN external_sent_at INTEGER;
