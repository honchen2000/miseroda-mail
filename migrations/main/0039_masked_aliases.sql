-- F9.4：Masked Email——使用者自助生成隨機別名 + 每別名停用開關 + 用途備註。
-- disabled=1 時 ingest 對外表現如「查無此人」直接拒收（絕不走過渡轉寄）；寄件身分同時失效。
ALTER TABLE aliases ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aliases ADD COLUMN note TEXT;
