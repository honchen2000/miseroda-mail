-- F9.1：spam/trash 30 天自動清 + F9.2 每資料夾保留規則的基礎欄位。
-- folder_changed_at = 訊息「進入目前資料夾」的時間（毫秒）。sweep 以此起算保留期。
ALTER TABLE messages ADD COLUMN folder_changed_at INTEGER;

-- 既有舊信一律以 migration 當下起算——絕不用 received_at 追溯（否則舊垃圾一部署就被清）。
UPDATE messages SET folder_changed_at = CAST(unixepoch('now') AS INTEGER) * 1000 WHERE folder_changed_at IS NULL;

-- sweep 查詢：WHERE folder IN (...) AND folder_changed_at < cutoff
CREATE INDEX IF NOT EXISTS idx_messages_folder_purge ON messages(folder, folder_changed_at);

-- 落信/匯入：一律以「寫入當下」起算，不用 received_at——mbox 匯入的舊信 received_at 在多年前，
-- 若以此起算會「剛匯入就過期被清」。正常落信 received_at≈now，兩者等價。
-- 用 trigger 集中維護，避免漏改任何一處 INSERT/UPDATE folder 造成保留期算錯（誤刪風險）。
CREATE TRIGGER trg_msg_folder_changed_ins AFTER INSERT ON messages
FOR EACH ROW WHEN NEW.folder_changed_at IS NULL
BEGIN
  UPDATE messages SET folder_changed_at = CAST(unixepoch('now') AS INTEGER) * 1000 WHERE id = NEW.id;
END;

-- 搬移資料夾（含移到垃圾桶/垃圾信）：重置起算時間為當下。
-- 關鍵安全性：一封兩年前的舊信今天被丟進垃圾桶，應從今天起算 30 天，而非立刻被清。
CREATE TRIGGER trg_msg_folder_changed_upd AFTER UPDATE OF folder ON messages
FOR EACH ROW WHEN NEW.folder IS NOT OLD.folder
BEGIN
  UPDATE messages SET folder_changed_at = CAST(unixepoch('now') AS INTEGER) * 1000 WHERE id = NEW.id;
END;
