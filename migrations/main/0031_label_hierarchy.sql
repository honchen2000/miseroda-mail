-- F4.5：標籤階層（parent_id，限 2 層）+ 自訂排序（sort_order）。純新增欄、非破壞。
ALTER TABLE labels ADD COLUMN parent_id  TEXT;                       -- NULL=頂層；否則指向頂層標籤
ALTER TABLE labels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0; -- 小→前（常用置頂）
