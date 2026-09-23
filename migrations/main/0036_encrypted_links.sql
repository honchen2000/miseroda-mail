-- F7.7 訊息級過期加密連結：寄敏感內容給外部收件人。瀏覽器端 AES-GCM 加密，
-- 站方只存「密文 + salt + iv + 到期」，無明文/無金鑰/無密碼（金鑰由 password ‖ URL fragment 派生）。
CREATE TABLE IF NOT EXISTS encrypted_links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,    -- 路徑能力憑證（高熵）
  user_id TEXT NOT NULL,
  subject TEXT,                  -- 明文標題（選填、非機密；寄件人列表辨識用）
  ciphertext TEXT NOT NULL,      -- base64 AES-GCM 密文（含 auth tag）
  salt TEXT NOT NULL,            -- base64 PBKDF2 salt
  iv TEXT NOT NULL,              -- base64 AES-GCM iv（12 bytes）
  opened_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_encrypted_links_user ON encrypted_links(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_encrypted_links_expires ON encrypted_links(expires_at);
