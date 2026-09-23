-- 行事曆重複事件 + 提醒。
-- rrule：RFC 5545 RRULE 值（如 FREQ=WEEKLY;INTERVAL=1）；NULL = 單次事件。
-- reminder_min：提醒提前分鐘數（0 = 開始時；NULL = 不提醒）。
-- reminder_next_ms：下次提醒應觸發的 epoch ms（移動指標，cron 掃描後前進到下一次發生）；NULL = 無待觸發。
ALTER TABLE calendar_events ADD COLUMN rrule TEXT;
ALTER TABLE calendar_events ADD COLUMN reminder_min INTEGER;
ALTER TABLE calendar_events ADD COLUMN reminder_next_ms INTEGER;

-- cron 每分鐘掃「到期且待觸發」的提醒：部分索引只收待觸發列，省成本。
CREATE INDEX idx_calevents_reminder ON calendar_events(reminder_next_ms) WHERE reminder_next_ms IS NOT NULL;
-- 月/週檢視展開重複事件時，需撈「rrule 非空且 base 起點早於範圍尾」的列。
CREATE INDEX idx_calevents_rrule ON calendar_events(user_id, start_ms) WHERE rrule IS NOT NULL;
