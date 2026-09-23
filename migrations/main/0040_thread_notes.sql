-- F9.7：線程私有便利貼 + 顯示主旨改寫（皆僅自己可見，不動原信、不進 FTS）。
CREATE TABLE IF NOT EXISTS thread_notes (
  user_id    TEXT NOT NULL REFERENCES users(id),
  thread_id  TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);

-- 顯示用主旨改寫：只影響列表/讀信呈現；搜尋（FTS 索引原主旨）與回覆引用（Re: 用原主旨）不受影響。
ALTER TABLE messages ADD COLUMN subject_override TEXT;
