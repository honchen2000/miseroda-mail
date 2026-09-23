-- F9.2 對抗式審查修復：mbox 匯入的歷史信是「刻意的永久檔案庫」，不該被封存保留規則
-- 整批清掉（匯入一律落 archive、不帶星標 → 豁免機制對它全部落空）。
-- 加標記欄，匯入時寫入；封存保留規則排除 import_job_id IS NOT NULL。
-- 本欄上線前已匯入的信無法回溯辨識（設定頁文案誠實提醒）。
ALTER TABLE messages ADD COLUMN import_job_id TEXT;
