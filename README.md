# Miseroda Mail

mail.miseroda.com — 企鵝 Pori × 極光主題的自架 webmail，跑在 Cloudflare 全家桶上的單一 Worker。

> 這是 2026-09-23 的原始碼公開快照，開發歷史與內部營運文件保留在私有 repo。
> 唯讀 demo（免註冊）：https://mail.miseroda.com/demo

## 架構

- **Worker**（單一）：`fetch`（Hono API + React SPA via Static Assets）、`email`（Email Routing ingest）、`queue`（寄信/ingest 後處理）、`scheduled`（排程寄送掃描、過期清理）
- **D1 ×2**：`miseroda-mail` 主庫（可 export 備份）、`miseroda-mail-fts` 全文檢索庫（FTS5 trigram，可重建）
- **R2**：原始 .eml、消毒後 HTML、附件
- **KV**:佇列冪等鍵、AI 快取
- **Queues**：`miseroda-send`（Undo Send via delaySeconds）、`miseroda-ingest`（消毒/FTS/規則）、`miseroda-dlq`
- **Workers AI**：信件摘要/分類/智慧回覆（按需）
- **認證**：邀請制 + WebAuthn Passkey + TOTP + 備援碼（無密碼、無 PBKDF2）

## 開發

```sh
npm install
npm run dev        # wrangler dev（API + 已建置的 SPA + email/queue/cron 模擬）
npm run dev:ui     # vite dev server（UI HMR，/api 代理到 :8787）
npm test           # 全套件，每批 8 檔逐批跑（scripts/test-batches.sh；vitest-pool-workers 跑在 workerd）
npm run typecheck
```

## 部署

push 到 `main` → Cloudflare Workers Builds 自動建置部署（build: `npm ci && npm run build`，deploy: `npm run deploy:remote`，會先套用兩庫 migrations）。

唯讀 demo 帳號的設計與防線：`docs/demo-runbook.md`

## 安全設計

無密碼（Passkey + TOTP + 備援碼）、邀請制、session HttpOnly + CSRF double-submit、
HTML 信三層消毒（HTMLRewriter 白名單 → sandbox iframe 無 script → 頁面 CSP）、
遠端圖片預設封鎖、附件授權 proxy（R2 永不公開）、全查詢 user_id 隔離（admin 也讀不到他人信件）、
敏感操作稽核、認證端點限流。
