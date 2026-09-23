-- F7.6 MBOX/EML 一次性匯入舊信：追蹤背景匯入進度（純新增表，不動既有資料）。
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,         -- 上傳的 mbox 在 R2 的 key
  filename TEXT,
  total INTEGER NOT NULL DEFAULT 0,   -- 切出的信件總數（首批處理時填）
  next_offset INTEGER NOT NULL DEFAULT 0, -- 下一批起點（DB 真相；冪等推進，queue retry 不重複計數/重排）
  done INTEGER NOT NULL DEFAULT 0,     -- 已匯入
  skipped INTEGER NOT NULL DEFAULT 0,  -- 重複（message_id 已存在）跳過
  failed INTEGER NOT NULL DEFAULT 0,   -- 解析失敗跳過
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | error
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_user ON import_jobs(user_id, created_at DESC);
