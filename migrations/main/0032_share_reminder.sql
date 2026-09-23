-- F4.6b：分享連結到期前提醒（每連結只提醒一次；延長後重置）。純新增欄、非破壞。
ALTER TABLE shared_files ADD COLUMN expiry_reminded INTEGER NOT NULL DEFAULT 0;
