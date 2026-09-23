-- F4.3b：聯絡人群組（「一鍵寄給家人」）。群組 + 成員 email；成員只存地址，顯示名由聯絡人/往來即時解析。
CREATE TABLE IF NOT EXISTS contact_groups (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_groups_user ON contact_groups(user_id);

CREATE TABLE IF NOT EXISTS contact_group_members (
  group_id TEXT NOT NULL REFERENCES contact_groups(id),
  email    TEXT NOT NULL,
  PRIMARY KEY (group_id, email)
);
