-- 跟進提醒：稍後跟進（到點提醒）/ 寄出等回覆（await_reply：到點若仍無回覆才提醒）。
CREATE TABLE follow_ups (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  message_id  TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  due_at      INTEGER NOT NULL,
  await_reply INTEGER NOT NULL DEFAULT 0,  -- 1=僅在該對話串到點前無新回覆時才提醒
  ref_at      INTEGER NOT NULL DEFAULT 0,  -- 設定當下訊息的 received_at（判斷之後是否有回覆）
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | fired | done
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, message_id)
);
CREATE INDEX idx_followups_due ON follow_ups(status, due_at);
CREATE INDEX idx_followups_user ON follow_ups(user_id, status, due_at);
