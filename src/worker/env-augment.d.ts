// 專案自有的 Env 擴充（介面宣告合併到 wrangler 自動產生的 __BaseEnv_Env）。
// DEMO_USER_ID 以 `wrangler secret put DEMO_USER_ID` 設定（不入 repo、不寫死 wrangler.jsonc）；
// 未設定時 /auth/demo-login 回 404（demo 功能預設關閉）。放這裡讓 wrangler types 重新產生時不被覆蓋。
interface __BaseEnv_Env {
  DEMO_USER_ID?: string;
  // 必要 secrets（`wrangler secret put`）。wrangler types 只從 .dev.vars 的 key 名推出它們，
  // 而 .dev.vars 被 gitignore → CI 與新 worktree 沒有它，型別就少這幾個欄位（LESSONS L10/L13）。
  // 型別必須與 wrangler 產生的一致（`string`，非可選），否則宣告合併會衝突。
  BOOTSTRAP_TOKEN: string;
  TOTP_ENC_KEY: string;
  VAPID_PRIVATE_JWK: string;
}
