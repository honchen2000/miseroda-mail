-- F11.2：行事曆 ICS 訂閱 feed。每使用者一顆唯讀 token（高熵、hash 存放、可撤銷重生）。
CREATE TABLE IF NOT EXISTS cal_feed_tokens (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
