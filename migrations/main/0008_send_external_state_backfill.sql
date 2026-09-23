-- 外送狀態機相容性回填：0007 只加了 external_state 欄位、未回填。
-- 在 0007 之前，外送是否成功是用 external_sent_at（0006）守門的。
-- 任何 external_sent_at 已有值的舊列，代表 provider 當時已接受 → 補標 external_state='accepted'，
-- 否則新版閘門（只看 external_state）會把它當成沒送過而重送外部信。
-- 對現有資料而言這是 no-op（正式庫無此種列），純為設計上封死「升級殘留列重送」窗口；冪等可重跑。
UPDATE send_queue SET external_state = 'accepted'
WHERE external_sent_at IS NOT NULL AND external_state IS NULL;
