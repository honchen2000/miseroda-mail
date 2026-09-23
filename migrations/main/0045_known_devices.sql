-- F12.3(a)：新裝置登入偵測——記錄每位使用者見過的「粗粒度裝置」（瀏覽器/OS，去版本號）。
-- 純加法建表，無 trigger。與 sessions 分離：sessions 會被 sweep 清，這張表是長期「見過的裝置」記憶，
-- 才能在舊 session 被清後仍正確判斷「這台是不是新裝置」，避免誤報。
CREATE TABLE IF NOT EXISTS known_devices (
  user_id       TEXT NOT NULL,
  ua_coarse     TEXT NOT NULL,     -- 例：Chrome / macOS（去掉版本號，瀏覽器升級不算新裝置）
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, ua_coarse)
);
