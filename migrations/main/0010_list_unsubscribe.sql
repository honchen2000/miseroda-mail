-- 一鍵退訂：收信時解析 List-Unsubscribe / List-Unsubscribe-Post 標頭，存退訂端點 JSON
-- （httpUrl 僅 https / mailto / 是否 RFC 8058 one-click），供閱讀窗顯示「退訂」按鈕。
ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
