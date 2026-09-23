-- 使用者大頭貼（R2 物件 key；實體在 avatar/{userId}/{ts}）
ALTER TABLE users ADD COLUMN avatar_key TEXT;
