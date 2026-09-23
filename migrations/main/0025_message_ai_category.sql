-- F2.2b：messages.ai_category —— AI 對來信的分類（帳單/工作/朋友/電子報/通知/其他），
-- 供規則的 ai_category 條件比對。NULL = 尚未/未分類。純新增欄，不破壞既有資料。
ALTER TABLE messages ADD COLUMN ai_category TEXT;
