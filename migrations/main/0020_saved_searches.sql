-- 儲存搜尋：把常用搜尋字串（含運算子）存起來、一鍵重用。
CREATE TABLE IF NOT EXISTS saved_searches (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
-- UNIQUE(user_id, query)：同一使用者同一查詢只存一份（防快速連點/多分頁產生重複），兼當查詢索引。
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_searches_user_query ON saved_searches(user_id, query);
