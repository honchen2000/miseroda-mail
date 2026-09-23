-- 寄件者信任卡：保存收信時擷取的 SPF/DKIM/DMARC 驗證結果（JSON {spf,dkim,dmarc}），供閱讀面板顯示信任徽章。
-- 收信時 Authentication-Results 標頭其實一直有擷取（ingest.ts collectAuthResults），但判完垃圾信就丟掉；這裡開始落地。
-- 既有信 auth_verdict = NULL（不顯示徽章，誠實留白）；新信於 ingest 寫入；可經 admin /messages/resanitize 回填。
ALTER TABLE messages ADD COLUMN auth_verdict TEXT;
-- 首次來信偵測（/messages/:id 查同 from_addr 是否有更早的信）+ 加速未來 from: 搜尋。
CREATE INDEX IF NOT EXISTS idx_messages_user_from ON messages(user_id, from_addr);
