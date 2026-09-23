-- 完整通訊錄：聯絡人增加電話欄位（手動新增 / vCard 匯入用）。
ALTER TABLE contacts ADD COLUMN phone TEXT NOT NULL DEFAULT '';
