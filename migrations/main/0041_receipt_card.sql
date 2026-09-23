-- F10.3：帳單/包裹 summary card——receipt lane 信 ingest 時 AI 抽結構化欄位（JSON）。
-- 純顯示用附欄；抽取失敗/非收據信為 NULL，不影響任何既有查詢。
ALTER TABLE messages ADD COLUMN receipt_card TEXT;
