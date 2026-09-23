-- F16.1（2026-09-20 安全掃描 F1/F4/F5）：收到的 .ics 原本只用 (user_id, uid) 當授權。
-- iCalendar UID 對「所有受邀者」公開（/calendar/invite 把 UID 寫進寄給每位 attendee 的 .ics），
-- 所以任何知道 UID 的人寄一封普通信就能改掉受害者的行事曆項目——包含使用者「自己建立」的事件。
--
-- 前兩輪修補被獨立驗證者擋下的原因（docs/product-roadmap.md F16.1），這個 migration 的形狀由它決定：
--   ① 綁「寄件者必須等於既存 organizer」→ 合法的中繼／代寄改期（訂票系統的 noreply 中繼、SENT-BY 代理）
--      會被靜默丟掉。
--   ② 改綁「建立該列那封信的 from_addr」→ 那個位址掛在 messages，而 lib/purge.ts 會硬刪 messages
--      → 原信被清掉之後，該事件從此「任何人都改不動」。
-- 正解：把授權位址存在 calendar_events 自己身上，**插入時寫、upsert 永不更新**
--（比照既有 source 欄位的處理方式——它同樣不在 ON CONFLICT DO UPDATE 的 SET 清單裡）。

-- 授權位址：能夠合法更新這一列的寄件地址。插入時寫死，之後永不更動。
ALTER TABLE calendar_events ADD COLUMN auth_addr TEXT NOT NULL DEFAULT '';
-- iTIP SEQUENCE：改期的單調性，擋掉「重放一份舊的 .ics 把時間改回去」。
ALTER TABLE calendar_events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
-- 被拒絕的更新要有「使用者看得見」的訊號（F16.1 驗收明列：只寫 admin-only audit 不算）。
ALTER TABLE calendar_events ADD COLUMN blocked_at INTEGER;
ALTER TABLE calendar_events ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '';

-- 回填既有列，否則它們的 auth_addr 會是空字串 → 永遠不符合授權 → 變成「誰都改不動」，
-- 正是上面擋點②要避免的下場。
-- 收到的邀請：優先用建立該列那封信的寄件者；信已被 purge 掉則退回 organizer。
UPDATE calendar_events
   SET auth_addr = COALESCE(
         (SELECT m.from_addr FROM messages m WHERE m.id = calendar_events.message_id),
         organizer)
 WHERE source = 'received' AND auth_addr = '';
-- 自建事件：授權位址就是擁有者自己（收到的 .ics 本來就不得更動 source='created' 的列，
-- 這裡寫上只是讓欄位語意一致、不留空洞）。
UPDATE calendar_events
   SET auth_addr = COALESCE((SELECT u.email FROM users u WHERE u.id = calendar_events.user_id), '')
 WHERE source = 'created' AND auth_addr = '';
