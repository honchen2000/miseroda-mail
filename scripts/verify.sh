#!/usr/bin/env bash
# 一鍵驗證（harness 物理阻斷，見 docs/harness/00-diagnosis.md 痛點 2）。
# 用法：
#   bash scripts/verify.sh                     # typecheck + build（不跑測試）
#   bash scripts/verify.sh test/worker/a.test.ts [b.test.ts ...]   # + 指定測試檔（≤8 個）
#   bash scripts/verify.sh --tests-only test/worker/a.test.ts      # 只跑測試（--tests-only 放哪個位置都行）
# 輸出契約（最末固定三行，供模型直接讀，永不截斷）：
#   RESULT: PASS | FAIL | ENV_FLAKE
#   STATS: <tsc/vite/vitest 統計原文摘要>
#   NEXT: <建議動作>
# 假綠防線（L11）：只要給了測試參數，PASS 就必須有真的統計——vitest 離開碼非 0、
# 或統計整段空白（零檔案命中）一律判 FAIL；ENV_FLAKE 已認領的情況不覆蓋。
# 洩漏防線（L14）：重試後仍有 flake 特徵、且同份輸出有洩漏特徵（LEAK_RE）→ 判 FAIL，不准報 ENV_FLAKE。
# 在前景執行（單一 tool-call 取得完整結果）；全程輸出留在暫存檔，FAIL 時自動附上尾段。
set -u
cd "$(dirname "$0")/.."

# mktemp 在受限沙盒可能失敗（實測：subagent 沙盒擋 /tmp → LOG 空字串 → 輸出寫進 repo 根目錄的 .t）
# ⚠ 樣板的 X 必須在**結尾**：BSD/macOS 的 mktemp 不會替換非結尾的 X。
#   原本寫成 verify.XXXXXX.log → 每次都 "mkstemp failed ... File exists" → 一律退回 .verify.log。
LOG="$(mktemp "${TMPDIR:-/tmp}/verify.XXXXXX" 2>/dev/null)" || LOG=".verify.log"
[ -n "$LOG" ] || LOG=".verify.log"
# 每輪從空的開始。退回 .verify.log 時各步驟是用 >> 追加，不清就會**跨執行累加**，
# 而下面的 STATS 是對整份 log grep 'error TS' → 會把前幾次執行的陳年錯誤一起報出來。
# （2026-09-20 實測踩到：一次失敗的 run 報出 6 個早就不存在的錯誤，直接誤導排查方向。）
: > "$LOG"
STATS=""; RESULT="PASS"; NEXT="可以 commit（roadmap 打勾＋完成日誌；含 migration 或 auth/刪除路徑者停在 commit 等 Hon push——五律 4）"

note() { echo "[verify] $*"; }

# ── 0. 環境自癒：node_modules 隨機被清（本機已知行為）──
if [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/vite ]; then
  note "node_modules 缺失（本機已知會被清空）→ npm ci"
  npm ci --no-audit --no-fund >>"$LOG" 2>&1 || { RESULT="FAIL"; STATS="npm ci failed"; NEXT="讀 $LOG 末 30 行，通常是網路或 lockfile 問題"; }
fi

# ── 0.5 參數解析：--tests-only 可放在任何位置（L11：舊版只認第 1 個參數，
#      放在檔名後面就原封不動傳給 vitest 當檔名過濾字串 → 零檔案命中）──
TESTS_ONLY=0
_argn=$#; _seen=0
while [ "$_seen" -lt "$_argn" ]; do
  _a="$1"; shift
  if [ "$_a" = "--tests-only" ]; then TESTS_ONLY=1; else set -- "$@" "$_a"; fi
  _seen=$((_seen + 1))
done

# ── 1. typecheck + build ──
if [ "$RESULT" = "PASS" ] && [ "$TESTS_ONLY" -eq 0 ]; then
  note "typecheck…"
  if ! npm run typecheck >>"$LOG" 2>&1; then
    RESULT="FAIL"
    STATS="$(grep -E 'error TS' "$LOG" | head -8 | tr '\n' ' | ')"
    NEXT="修上列 TS 錯誤；完整輸出在 $LOG"
  else
    note "build…"
    if ! npm run build >>"$LOG" 2>&1; then
      RESULT="FAIL"
      STATS="$(grep -iE 'error|failed' "$LOG" | tail -5 | tr '\n' ' | ')"
      NEXT="修 build 錯誤；完整輸出在 $LOG"
    else
      STATS="typecheck ✓; $(grep -oE '✓ built in [0-9.]+m?s' "$LOG" | tail -1)"
    fi
  fi
fi

# ── 1.5 安全標頭一致性：靜態資產走邊緣直送(_headers)，worker 路由走 withSecurityHeaders，兩處禁止漂移 ──
if [ "$RESULT" = "PASS" ]; then
  if ! node scripts/check-csp-parity.mjs >>"$LOG" 2>&1; then
    RESULT="FAIL"
    STATS="$STATS; CSP/安全標頭漂移"
    NEXT="同步 src/worker/index.ts 的 CSP/安全標頭與 public/_headers（詳見 $LOG 末段）"
  fi
fi

# ── 2. 測試（可選；含 workerd 冷卻與已知環境 flake 判別＋單次重試）──
FLAKE_RE='Isolated storage failed|\.sqlite-shm|EADDRNOTAVAIL|ERR_RUNTIME_FAILURE|Connection refused'
# L14：.sqlite-shm／Isolated storage 也是「測試把工作漏到 it() 之外」的症狀（背景 queue 自動投遞、
# 沒 await 的 waitUntil 打到已回滾的 storage frame）。同一份輸出若另有洩漏特徵＝真洩漏，判 FAIL 不判 ENV_FLAKE。
# no such table＝frame 已回滾；[queue.<kind>] Error＝logError 印的 consumer 失敗。
# 已知偽陽：send.test.ts 的暫時性錯誤 retry 測試本來就會印 [queue.send] Error——只會把真環境 flake 報成 FAIL，不會假綠。
LEAK_RE='no such table|\[queue\.[a-z-]+\] Error'
LEAK=0
T_CODE=0
run_tests() {
  pkill -9 -f workerd 2>/dev/null; pkill -9 -f esbuild 2>/dev/null; sleep 2
  npx vitest run "$@" >"$LOG.t" 2>&1
}

# --tests-only 但一個測試檔都沒給 = 這一輪什麼都沒驗到（跳過 build 又沒有測試）→ 不准回 PASS
if [ "$RESULT" = "PASS" ] && [ "$TESTS_ONLY" -eq 1 ] && [ "$#" -eq 0 ]; then
  RESULT="FAIL"
  STATS="未指定測試檔（--tests-only 已跳過 typecheck/build）"
  NEXT="--tests-only 至少要給一個測試檔，否則整輪零驗證。用法：bash scripts/verify.sh --tests-only test/worker/a.test.ts"
fi

if [ "$RESULT" = "PASS" ] && [ "$#" -gt 0 ]; then
  note "tests: $*"
  run_tests "$@"; T_CODE=$?
  T_STATS="$(grep -E 'Test Files|Tests ' "$LOG.t" | tr '\n' ' | ')"
  if grep -qE "$FLAKE_RE" "$LOG.t"; then
    note "偵測到已知環境 flake 特徵 → 冷卻 10s 重試一次"
    pkill -9 -f workerd 2>/dev/null; sleep 10
    run_tests "$@"; T_CODE=$?
    T_STATS="$(grep -E 'Test Files|Tests ' "$LOG.t" | tr '\n' ' | ')"
    if grep -qE "$FLAKE_RE" "$LOG.t" && grep -qE "$LEAK_RE" "$LOG.t"; then
      # d9699e9 前的 screening.test.ts 就是這樣：4/4 次 flake 特徵＋[queue.ingest] no such table，被報成 ENV_FLAKE
      RESULT="FAIL"; LEAK=1
      T_STATS="${T_STATS:+$T_STATS; }洩漏特徵 $(grep -cE "$LEAK_RE" "$LOG.t") 行"
      NEXT="測試洩漏，不是環境 flake（L14）：flake 特徵旁同時有 no such table／[queue.<kind>] Error＝背景 queue 自動投遞或沒 await 的 waitUntil 在 it() 之外碰 storage。照 LESSONS L5/L14 修：worker.email/fetch 改傳 queue send 為 noop 的 quietEnv＋手動跑 batch，每個 createExecutionContext() 都 await waitOnExecutionContext(ctx)（先例 screening.test.ts／auto-draft.test.ts）。證據：grep -nE 'no such table|\[queue\.' $LOG.t；若命中的只有測試刻意製造的 [queue.*] 錯誤且無 no such table，才回頭當 L3 環境問題"
    elif grep -qE "$FLAKE_RE" "$LOG.t"; then
      RESULT="ENV_FLAKE"
      NEXT="環境 flake（非程式問題，CLAUDE.md 有記載）。等 30s 後單獨重跑該檔；連 3 次 flake 才需要懷疑程式，先跑 git stash baseline 對照"
    fi
  fi
  if [ "$LEAK" -eq 1 ]; then
    echo "── 洩漏特徵（L14，前 8 行）──"
    grep -nE "$LEAK_RE" "$LOG.t" | cut -c1-220 | head -8
  elif [ "$RESULT" != "ENV_FLAKE" ] && [ -z "$T_STATS" ]; then
    # 零檔案命中／vitest 根本沒跑起來：舊版在這裡維持 PASS（L11 假綠）
    RESULT="FAIL"
    T_STATS="沒有任何測試被執行（vitest 未輸出 Test Files/Tests 統計，exit=$T_CODE）"
    NEXT="沒有測試檔被匹配到——vitest 把參數當檔名子字串過濾，先確認路徑拼字／是否漏了 test/ 前綴／檔案是否存在；完整輸出在 $LOG.t。這一輪等於沒驗到，不是通過"
    echo "── vitest 輸出末段 ──"; tail -15 "$LOG.t"
  elif [ "$RESULT" != "ENV_FLAKE" ] && { [ "$T_CODE" -ne 0 ] || grep -qE 'failed' <<<"$T_STATS"; }; then
    RESULT="FAIL"
    NEXT="讀失敗斷言：grep -B2 -A10 '×' $LOG.t（vitest exit=$T_CODE）"
    echo "── 失敗測試摘要 ──"
    if grep -q '×' "$LOG.t"; then grep -B1 -A6 '×' "$LOG.t" | head -40; else tail -20 "$LOG.t"; fi
  fi
  if [ -n "$STATS" ]; then STATS="$STATS; $T_STATS"; else STATS="$T_STATS"; fi
  pkill -9 -f workerd 2>/dev/null
fi

echo ""
echo "RESULT: $RESULT"
echo "STATS: ${STATS:-（無）}"
echo "NEXT: $NEXT"
