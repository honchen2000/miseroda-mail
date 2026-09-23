-- 行事曆會議邀請：收信時若含 text/calendar（.ics）部分，解析後的事件 JSON 存此欄，
-- 供閱讀窗顯示邀請卡（標題/時間/地點/主辦）。原始 .ics 另存 R2（cal/ 前綴）供「加入行事曆」下載。
ALTER TABLE messages ADD COLUMN calendar_event TEXT;
