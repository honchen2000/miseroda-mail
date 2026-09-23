-- 會議邀請的出席回覆狀態（RSVP）：accepted / tentative / declined / NULL（未回覆）
-- 使用者在邀請卡按「接受/暫定/拒絕」後，除了寄出 iCalendar REPLY 給組織者，也在此記錄供 UI 回顯。
ALTER TABLE messages ADD COLUMN rsvp_status TEXT;
