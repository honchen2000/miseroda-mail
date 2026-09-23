-- F2.8b：使用者按過「退訂」的寄件者。之後同一寄件者又寄來 → ingest 自動歸檔 + 標記，
-- 不再吵收件匣（退訂後對方仍寄送是常見惡習）。純新增，不動既有資料。
CREATE TABLE IF NOT EXISTS unsubscribed_senders (
  user_id    TEXT NOT NULL REFERENCES users(id),
  sender     TEXT NOT NULL,            -- 小寫 from_addr
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sender)
);

-- 「已退訂卻又寄來」標記：供前端徽章顯示。既有信 = 0（誠實留白），新信於 ingest 命中時設 1。
ALTER TABLE messages ADD COLUMN unsub_resend INTEGER NOT NULL DEFAULT 0;
