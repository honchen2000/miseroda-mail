-- 聯絡人：自訂顯示名稱/備註（聚合資料由 messages 即時算，這裡只存使用者覆寫）
CREATE TABLE contacts (
  user_id     TEXT NOT NULL REFERENCES users(id),
  email       TEXT NOT NULL,
  custom_name TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, email)
);
