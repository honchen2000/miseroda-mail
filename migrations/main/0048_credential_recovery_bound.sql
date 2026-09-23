-- 標記「只憑 admin 核發的救援連結綁定、從未經第二因子確認」的 passkey。
-- 救援流程刻意只「加 passkey、不發 session」，安全性完全靠登入時仍需既有 TOTP；
-- 一旦 admin 重設該帳號 TOTP，這些 passkey 就能走免 TOTP 快路徑登入並自行重設 TOTP＝完整接管信箱。
-- 伺服器無法分辨「本人綁的」與「攔截救援連結者綁的」，故重設 TOTP 前要求 admin 逐一承認（api/admin.ts）。
ALTER TABLE credentials ADD COLUMN recovery_bound INTEGER NOT NULL DEFAULT 0;

-- 回填既有資料：救援完成自功能上線起就寫 audit_log（action='auth.recover.complete'、meta.credentialId），
-- 且 audit_log 從不清除（帳號刪除時亦刻意保留）→ 涵蓋所有既有的救援綁定 passkey。
UPDATE credentials SET recovery_bound = 1
 WHERE id IN (
   SELECT json_extract(a.meta, '$.credentialId') FROM audit_log a
    WHERE a.action = 'auth.recover.complete' AND json_extract(a.meta, '$.credentialId') IS NOT NULL
 );
