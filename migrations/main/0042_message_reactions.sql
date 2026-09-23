-- F11.1：站內 emoji 反應。以 message_id_header 為 key（deliverInternal 的每收件人複本
-- 與寄件備份共享同一 header）→ A 對信按 👍，B 在自己的複本上看得到。僅站內信顯示/可反應。
CREATE TABLE IF NOT EXISTS message_reactions (
  header     TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (header, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_header ON message_reactions(header);
