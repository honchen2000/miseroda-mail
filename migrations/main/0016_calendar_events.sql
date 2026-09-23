-- 行事曆檢視用的事件表：由收到的邀請（ingest）、自建會議邀請、RSVP 狀態共同填充。
-- start_ms 一律存（UTC/日期事件為真實 epoch；帶 TZID 的浮動時間以牆鐘字串近似為 epoch，僅供「日期分桶」，
-- 顯示時用 start_text 還原牆鐘時間，floating=1 標記之）。
CREATE TABLE calendar_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  uid           TEXT NOT NULL,              -- iCalendar UID（同一 user 內去重 / 更新）
  summary       TEXT NOT NULL DEFAULT '',
  start_ms      INTEGER NOT NULL,           -- 分桶用 epoch（見上）
  end_ms        INTEGER,
  start_text    TEXT NOT NULL DEFAULT '',   -- 顯示用時間字串（牆鐘）
  all_day       INTEGER NOT NULL DEFAULT 0,
  floating      INTEGER NOT NULL DEFAULT 0, -- 1=帶時區/浮動，顯示用 start_text 不做時區換算
  location      TEXT NOT NULL DEFAULT '',
  organizer     TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'received', -- received | created
  rsvp_status   TEXT,                       -- accepted | tentative | declined | NULL
  message_id    TEXT,                       -- 對應的信件 id（received）
  created_at    INTEGER NOT NULL,
  UNIQUE (user_id, uid)
);
CREATE INDEX idx_calevents_user_start ON calendar_events(user_id, start_ms);
