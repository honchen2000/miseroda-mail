-- F11：自動轉寄的「迴圈斷點」不再用可偽造的固定標頭值（X-Miseroda-Forwarded: 1）。
-- 每封外寄轉寄信改帶一個系統核發的隨機 marker，落地時查本表命中才算「這是本系統產生的轉寄信」。
-- 刻意「不」用 user_id 查驗（見 forward.ts hasSystemForwardMarker）：marker 是 256-bit 隨機值、
-- 外人偽造不出來，全站採信才能讓 A→外部→B 這類跨使用者的轉寄迴圈在第一代就斷掉。
CREATE TABLE IF NOT EXISTS forward_markers (
  marker     TEXT PRIMARY KEY,  -- 系統核發的隨機值（= 外寄信 X-Miseroda-Forwarded 標頭值）
  user_id    TEXT NOT NULL REFERENCES users(id),  -- 核發者（稽核用，非查驗條件）
  message_id TEXT NOT NULL,     -- 被轉寄的原信 id（稽核用，不外流：標頭只帶 marker）
  created_at INTEGER NOT NULL
);
-- TTL 掃除（sweep）用
CREATE INDEX IF NOT EXISTS idx_forward_markers_created ON forward_markers(created_at);
