-- 每使用者貝氏垃圾分類器的學習資料。
-- token 計數表：每個 token 在該使用者的 spam / ham 訊息中各出現過幾封（以「出現與否」計，非詞頻）。
CREATE TABLE spam_tokens (
  user_id    TEXT NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL,
  spam_count INTEGER NOT NULL DEFAULT 0,
  ham_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, token)
);

-- 語料計數：已訓練的 spam / ham 訊息總數（用於機率正規化與「訓練量足夠才啟用」門檻）。
CREATE TABLE spam_train_stats (
  user_id   TEXT PRIMARY KEY REFERENCES users(id),
  spam_msgs INTEGER NOT NULL DEFAULT 0,
  ham_msgs  INTEGER NOT NULL DEFAULT 0
);

-- 每封訊息的訓練狀態（NULL=未訓練 / 'spam' / 'ham'）：避免重複計數，並支援來回切換時反向修正。
ALTER TABLE messages ADD COLUMN spam_trained TEXT;
