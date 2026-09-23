-- F16.2（2026-09-20 安全掃描 F8）：收到的 METHOD:CANCEL 原本直接 DELETE，只比對 (user_id, uid, source='received')
-- → 任何知道 UID 的人（同一封邀請的其他受邀者都知道）寄一封信就能把受害者的會議刪掉，提醒也一起消失。
--
-- 前兩輪修補被擋下的原因（docs/product-roadmap.md F16.2），這個 migration 的形狀由它決定：
--   ① 把授權綁在 organizer／message_id → 那兩個欄位正好可被 upsert 覆寫：攻擊者先寄一封同 UID 的
--      REQUEST 把 organizer 改成自己、再寄 CANCEL，照刪；更糟的是真 organizer 之後反而刪不掉，
--      等於多了一個「把攻擊者內容永久釘在受害者行事曆上」的能力。（此點已由 F16.1 的 auth_addr 關掉。）
--   ② 就算授權綁對了，**全樹只有這一條刪除路徑**（/calendar/* 沒有刪除端點、admin 批次不含此表、
--      purge.ts 不碰、UI 沒有刪除鍵）→ 任何被拒的取消＝事件永遠移不掉、提醒繼續跑。
-- 正解：不刪，標「待確認取消」，並補一條使用者確認的移除端點（順帶補掉②那個既有缺口）。

-- 1 = 有一封通過授權的 CANCEL 進來，等使用者確認是否移除。未經授權的取消不會設這個旗標，
-- 只會留下 F16.1 的 blocked_at／blocked_by 警示，事件本身完全不動。
ALTER TABLE calendar_events ADD COLUMN cancel_pending INTEGER NOT NULL DEFAULT 0;
-- 是誰要求取消的（顯示給使用者看，讓他判斷這個取消合不合理）。
ALTER TABLE calendar_events ADD COLUMN cancel_by TEXT NOT NULL DEFAULT '';
