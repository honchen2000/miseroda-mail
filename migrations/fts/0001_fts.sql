-- 全文檢索庫（與主庫分離：FTS5 虛擬表會讓 wrangler d1 export 失敗，
-- 主庫保持可備份，本庫可隨時由主庫 + R2 重建）
-- trigram tokenizer：支援中文/任意子字串比對（查詢需 >= 3 字元，短查詢走主庫 LIKE fallback）

CREATE TABLE msg_map (
  fts_rowid  INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL
);
CREATE INDEX idx_msg_map_user ON msg_map(user_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  from_addr,
  snippet,
  body_text,
  tokenize = 'trigram'
);
