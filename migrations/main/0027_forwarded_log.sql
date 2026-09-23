-- F4.1b：自動轉寄去重。同一封信對同一目標只轉一次（防 queue 重跑 / 重複套規則造成重複轉寄）。
-- 與 X-Miseroda-Forwarded 標頭 + 站內 forwarded 旗標一起構成迴圈防護（轉寄信不再被轉寄）。
CREATE TABLE IF NOT EXISTS forwarded_log (
  user_id    TEXT NOT NULL REFERENCES users(id),
  message_id TEXT NOT NULL,   -- 被轉寄的原信 id
  target     TEXT NOT NULL,   -- 小寫目標 email
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id, target)
);
