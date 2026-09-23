-- F4.3a：聯絡人模型補完——公司/職稱/生日/地址（手動編輯 + vCard 匯入/匯出保留）。純新增欄、非破壞。
ALTER TABLE contacts ADD COLUMN company  TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN title    TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN birthday TEXT NOT NULL DEFAULT ''; -- ISO 'YYYY-MM-DD' 或 '--MM-DD'（無年）
ALTER TABLE contacts ADD COLUMN address  TEXT NOT NULL DEFAULT '';
