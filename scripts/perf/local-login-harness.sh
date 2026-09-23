#!/usr/bin/env bash
# 本機「登入態」量測環境（效能迴圈用）。只碰本機模擬庫，**絕不連正式環境**。
#
# 做的事：在指定的獨立目錄建一份本機 D1（套全部 migrations）→ 塞一個合成測試使用者
# （已啟用 TOTP 旗標、一個 30 天的 session）→ 印出要在瀏覽器設定的 cookie。
# 之後用 `npx wrangler dev --local --persist-to <目錄> --port 8787` 起服務（前端取 dist/，先 build），
# 在 http://127.0.0.1:8787 的 console 設 cookie 後重新載入，即為登入狀態。
#
# 為什麼安全：所有 wrangler 指令都明確帶 --local 與 --persist-to；合成使用者只存在該目錄的 SQLite 裡，
# token 是本機隨機產生的，對正式站毫無效力（正式站根本沒有這筆 session）。
#
# 用法：bash scripts/perf/local-login-harness.sh <獨立目錄，例如 /tmp/miseroda-perf-state>
set -euo pipefail
DIR="${1:?請給一個獨立的 persist 目錄}"
case "$DIR" in */.wrangler*|"$PWD"*) echo "拒絕：請用 repo 以外的獨立目錄，避免和日常開發的本機狀態混在一起" >&2; exit 1;; esac
mkdir -p "$DIR"
echo y | npx wrangler d1 migrations apply miseroda-mail-apac --local --persist-to "$DIR" >/dev/null
echo y | npx wrangler d1 migrations apply miseroda-mail-fts-apac --local --persist-to "$DIR" >/dev/null
TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
SID=$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$TOKEN")
NOW=$(node -e 'console.log(Date.now())'); EXP=$((NOW + 30*24*3600*1000))
npx wrangler d1 execute miseroda-mail-apac --local --persist-to "$DIR" --command "
  INSERT OR IGNORE INTO users (id,email,display_name,role,status,created_at,is_demo) VALUES ('perf-u1','perf@miseroda.com','效能測試','user','active',$NOW,0);
  INSERT OR IGNORE INTO totp_secrets (user_id,secret_enc,enabled,created_at) VALUES ('perf-u1','local-dummy',1,$NOW);
  INSERT INTO sessions (id,user_id,client,created_at,expires_at) VALUES ('$SID','perf-u1','web',$NOW,$EXP);" >/dev/null
echo "完成。本機 .dev.vars 的 ORIGIN 是 http → cookie 名為 'session'（非 __Host-）。在 http://127.0.0.1:8787 的 console 執行："
echo "document.cookie = 'session=$TOKEN; Path=/; SameSite=Strict'"
