-- 乾淨網域別名（prefix@miseroda.com）：admin 指派給使用者。
-- 收信時路由到擁有者（ingest fallback）；寄送時可選為寄件身分（send 端驗證擁有權）。
-- address 全域 UNIQUE：不可兩人共用、不可與使用者 email 撞（POST 另做防呆）。
CREATE TABLE IF NOT EXISTS aliases (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  address     TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_user ON aliases(user_id);
