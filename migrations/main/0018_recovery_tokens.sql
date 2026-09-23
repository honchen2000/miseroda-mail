-- passkey 救援 token：admin 對「既有使用者」核發一次性、限期的「重新綁定 passkey」連結，
-- 解決使用者失去所有 passkey 後的鎖死陷阱（passkey-only + email UNIQUE 無法重註冊）。
-- 仿 invites：明碼只回核發者一次，DB 只存雜湊。
CREATE TABLE recovery_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  created_by  TEXT,                  -- 核發的 admin user id（稽核用）
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER                -- 單次使用：綁定成功即標記
);
CREATE INDEX idx_recovery_hash ON recovery_tokens(token_hash);
CREATE INDEX idx_recovery_user ON recovery_tokens(user_id);
