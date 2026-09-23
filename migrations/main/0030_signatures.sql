-- F4.4：多重簽名 + 綁寄件身分。signatures 存純文字（套用時 escape+nl2br，無 XSS）；aliases 綁 signature_id。
CREATE TABLE IF NOT EXISTS signatures (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signatures_user ON signatures(user_id);

-- 別名綁定簽名（NULL = 用預設簽名）。純新增欄、非破壞。
ALTER TABLE aliases ADD COLUMN signature_id TEXT;
