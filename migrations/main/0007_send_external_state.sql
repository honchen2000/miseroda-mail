-- 外送結果狀態機：與整體 status 解耦的外送階段標記。
--   NULL        尚未嘗試外送（或無外部收件人）
--   'attempting' 已持久化「即將外送」；provider 結果未定 → 重試不得自動重送
--   'accepted'   provider 已接受 → 重試一律跳過外送，只重跑本地收尾
-- 配合 status='failed' + last_error='external_uncertain' 表示「待使用者裁決」，
-- 免動 status 的 CHECK 約束（SQLite 無法直接改 CHECK）。
ALTER TABLE send_queue ADD COLUMN external_state TEXT;
