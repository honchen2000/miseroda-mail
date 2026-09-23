-- F5.6a：儲存搜尋可釘到側欄當自訂視圖分頁。純加性（既有搜尋預設 0＝未釘）。
ALTER TABLE saved_searches ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
