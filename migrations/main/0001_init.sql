-- Miseroda Mail 主庫 schema
-- 信件內文與附件實體放 R2，D1 只存中繼資料 + snippet（控制 10GB 上限增長）

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- WebAuthn 憑證（id = credential ID base64url）
CREATE TABLE credentials (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  public_key   TEXT NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,
  device_type  TEXT,
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_credentials_user ON credentials(user_id);

CREATE TABLE totp_secrets (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  secret_enc TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE backup_codes (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at   INTEGER
);
CREATE INDEX idx_backup_codes_user ON backup_codes(user_id);

-- id = SHA-256(session token)，token 本身只存在 cookie
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  client     TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  invited_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX idx_invites_email ON invites(email);

-- WebAuthn/TOTP challenge 存 D1（強一致；KV 最終一致會偶發掉 challenge）
CREATE TABLE challenges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  type       TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_challenges_expires ON challenges(expires_at);

CREATE TABLE threads (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  subject         TEXT NOT NULL DEFAULT '',
  last_message_at INTEGER NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_threads_user ON threads(user_id, last_message_at DESC);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  thread_id         TEXT NOT NULL,
  message_id_header TEXT,
  in_reply_to       TEXT,
  references_header TEXT,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_addr         TEXT NOT NULL,
  from_name         TEXT NOT NULL DEFAULT '',
  to_addrs          TEXT NOT NULL DEFAULT '[]',
  cc_addrs          TEXT NOT NULL DEFAULT '[]',
  bcc_addrs         TEXT NOT NULL DEFAULT '[]',
  subject           TEXT NOT NULL DEFAULT '',
  snippet           TEXT NOT NULL DEFAULT '',
  r2_raw_key        TEXT,
  r2_html_key       TEXT,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  has_attachments   INTEGER NOT NULL DEFAULT 0,
  remote_images     INTEGER NOT NULL DEFAULT 0,
  is_read           INTEGER NOT NULL DEFAULT 0,
  is_starred        INTEGER NOT NULL DEFAULT 0,
  folder            TEXT NOT NULL DEFAULT 'inbox'
                    CHECK (folder IN ('inbox', 'sent', 'drafts', 'archive', 'spam', 'trash')),
  spam_score        INTEGER,
  ai_summary        TEXT,
  received_at       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_messages_user_folder ON messages(user_id, folder, received_at DESC);
CREATE INDEX idx_messages_thread ON messages(user_id, thread_id, received_at);
CREATE INDEX idx_messages_header ON messages(user_id, message_id_header);

CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  disposition TEXT,
  content_id TEXT,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_user ON attachments(user_id, created_at);

CREATE TABLE labels (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#5FF6C2',
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX idx_labels_user ON labels(user_id);

CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id),
  label_id   TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (message_id, label_id)
);

CREATE TABLE rules (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  conditions TEXT NOT NULL,
  actions    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_rules_user ON rules(user_id, priority);

CREATE TABLE drafts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_drafts_user ON drafts(user_id, updated_at DESC);

CREATE TABLE send_queue (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled'
               CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'canceled')),
  scheduled_at INTEGER NOT NULL,
  sent_at      INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  message_id   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_send_queue_due ON send_queue(status, scheduled_at);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  ip          TEXT,
  user_agent  TEXT,
  meta        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE user_settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  signature  TEXT NOT NULL DEFAULT '',
  prefs      TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
