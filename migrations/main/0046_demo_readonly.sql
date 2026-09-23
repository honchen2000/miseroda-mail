-- 唯讀 demo 帳號旗標：is_demo=1 的使用者可讀信箱、但所有變更請求被 requireSession 擋成 403 demo_readonly。
-- 純加法（ADD COLUMN，預設 0）——不動既有 role CHECK 約束、不影響任何現有帳號。
ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
