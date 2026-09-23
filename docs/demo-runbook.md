# 唯讀 Demo 帳號 Runbook

求職招募方免註冊、免 passkey，一鍵進 `mail.miseroda.com/demo` 參觀。**硬性唯讀**：伺服器端擋掉所有變更請求（寄信/刪除/設定/AI…一律 403 `demo_readonly`），寄不出真信、動不了任何資料。

## 防線（設計，動之前先讀）
- **伺服器端才是防線**：`requireSession` middleware 對 `is_demo=1` 的帳號，任何 `POST/PUT/PATCH/DELETE` → 403（唯一放行 `/auth/logout` 讓人離場）。前端隱藏寫信只是 UX。
- **`/share-target`**（在 Hono 之外的寫入端）也另外補了 `is_demo` 守門。
- **demo-login 縱深防禦**：`POST /auth/demo-login` 只對「`status=active` 且 `is_demo=1`」的帳號發 session；`DEMO_USER_ID` 誤設成真帳號 → 404，不會發出真帳號的 passwordless session。
- **預設關閉**：`DEMO_USER_ID` 未設 → demo-login 回 404，功能整個關閉。

## 建立 / 重建（依序）
1. **確認已部署**（含 migration `0046_demo_readonly`：`users.is_demo`）。未部署時 `is_demo` 欄位不存在，下面的 UPDATE 會報 `no such column`。
2. **建 demo 帳號**：admin 邀請 `demo@miseroda.com` → 走完註冊（passkey + TOTP）。此時 `is_demo=0`。
3. **趁 `is_demo=0` 灌假信**（務必在翻旗標之前，否則寫入被擋）：
   - 準備 mbox（假信、寄件人全 `@example.com`）。產生器：`scripts` 或請 Claude 生一份（先例：`demo-inbox.mbox`，24 封）。
   - 登入 demo 帳號 → 設定 → 匯入舊信 → 上傳 mbox。匯入端**一律落在「封存」、標已讀**。
   - 搬進收件匣 + 做未讀感（`<DEMO_ID>` = `SELECT id FROM users WHERE email='demo@miseroda.com'`）：
     ```bash
     wrangler d1 execute miseroda-mail --remote --command="UPDATE messages SET folder='inbox' WHERE user_id='<DEMO_ID>' AND import_job_id IS NOT NULL"
     wrangler d1 execute miseroda-mail --remote --command="UPDATE messages SET is_read=0 WHERE user_id='<DEMO_ID>' AND import_job_id IS NOT NULL AND received_at >= <cutoff_ms>"
     ```
4. **鎖成唯讀**：
   ```bash
   wrangler d1 execute miseroda-mail --remote --command="UPDATE users SET is_demo=1 WHERE email='demo@miseroda.com'"
   ```
5. **開啟一鍵進場**（secret，即時生效、不需再部署）：
   ```bash
   wrangler secret put DEMO_USER_ID   # 貼上 <DEMO_ID>
   ```
6. **驗收**：開 `/demo` → 進入 → 應見唯讀橫幅、信件可讀、寫信入口消失、任何變更被擋。

## 關閉 demo
```bash
wrangler secret delete DEMO_USER_ID   # demo-login 立即回 404
```

## 常見雷（重要）
- **順序**：`is_demo=1` 一旦執行，當下的 demo 登入立刻變唯讀——要再灌信/調整就趁 `is_demo` 還是 0 時做完。
- **降級撤 session**：若把某帳號 `is_demo` 改回 0，**務必**同時 `revokeAllSessions`（`POST /auth/sessions/revoke-all` 或直接清 `sessions`）——否則它現存、效期最長 30 天的 demo session 會在下一個請求立刻變回完整帳號。
- **雙語**：`/demo` 落地頁 + 唯讀橫幅 + 寫信提示會依瀏覽器語言顯示（中文語系→繁中，其餘→英文）；app 其餘維持全繁中。
- **進階卡片**：mbox 匯入走精簡管線，**不會**自動產生收據卡/會議邀請卡/AI 分類分頁（那些在即時收信 ingest 才跑）。要 demo 那些亮點需走真實收信路徑另外 seed。
