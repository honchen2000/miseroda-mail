#!/usr/bin/env bash
# 全套件分批跑（CI 用；本機要跑全套件也用這支）。見 docs/harness/LESSONS.md L14。
# 用法：
#   bash scripts/test-batches.sh            # test/ 底下所有 *.test.ts，每批 8 檔
#   TEST_BATCH_SIZE=4 bash scripts/test-batches.sh
#   bash scripts/test-batches.sh test/worker/a.test.ts …   # 只跑指定檔（自測用）
#
# 為什麼不直接 `vitest run`：@cloudflare/vitest-pool-workers 0.8 在 isolatedStorage 模式下
# 「每個測試檔起一個 workerd」，而且一次全部起、全部同時跑（不看 maxWorkers）。
# 120 檔＝120 個 workerd 同時向同一個 Node 行程要模組：
#   - CI（私有 repo 的小 runner）：Node 端被拖垮，resolveId/fetch RPC 60s 逾時，120 檔全滅、一則測試都沒跑
#   - 本機 macOS：ephemeral port 用完（EADDRNOTAVAIL／fallback service Connection refused），十幾秒就崩
# 每批 8 檔＝verify.sh 的上限，也是全套件「15 批 × 8」的既有驗證方式。
#
# 假綠防線（L11）：每批都要 vitest 離開碼 0，且 `Test Files N passed (N)` 的 N 等於該批檔數；
# 最後加總必須等於 find 找到的檔數。任何一批不符 → 整體 FAIL（其餘批次照跑完，一次看到全部失敗）。
# 不做任何重試：CI 要誠實反映 flaky。
set -u
cd "$(dirname "$0")/.."

BATCH="${TEST_BATCH_SIZE:-8}"
GH="${GITHUB_ACTIONS:-}"

FILES=()
if [ "$#" -gt 0 ]; then
  FILES=("$@")   # 給了檔案就只跑這些（自測本腳本用）
else
  while IFS= read -r f; do FILES+=("$f"); done < <(find test -name '*.test.ts' | LC_ALL=C sort)
fi
TOTAL=${#FILES[@]}
if [ "$TOTAL" -eq 0 ]; then
  echo "[test-batches] 找不到任何 *.test.ts——這一輪等於沒驗到" >&2
  exit 1
fi
NB=$(( (TOTAL + BATCH - 1) / BATCH ))
echo "[test-batches] $TOTAL 個測試檔，每批 ≤$BATCH，共 $NB 批（CPU=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo '?')）"

LOG="$(mktemp "${TMPDIR:-/tmp}/test-batches.XXXXXX" 2>/dev/null)" || LOG=".test-batches.log"

# 每個 workerd 載入模組約開 600 條 loopback 短連線（實測），macOS 的 ephemeral port 只有 16K、
# TIME_WAIT 30s → 背靠背跑三批就 EADDRNOTAVAIL。每批開跑前等可用 port 夠用（最多 90s）。
# Linux 的 port 範圍較大且 loopback 預設 tcp_tw_reuse，CI 上通常一秒都不用等。
port_range() {
  if [ -r /proc/sys/net/ipv4/ip_local_port_range ]; then
    awk '{print $2 - $1 + 1}' /proc/sys/net/ipv4/ip_local_port_range
  else
    echo $(( $(sysctl -n net.inet.ip.portrange.last) - $(sysctl -n net.inet.ip.portrange.first) + 1 ))
  fi
}
tw_count() {
  if command -v ss >/dev/null 2>&1; then ss -Htan state time-wait | wc -l
  else netstat -an -p tcp 2>/dev/null | grep -c TIME_WAIT; fi
}
RANGE="$(port_range 2>/dev/null || echo 0)"
NEED=$((700 * BATCH))
wait_for_ports() {
  [ "$RANGE" -gt 0 ] 2>/dev/null || return 0
  local i=0 tw
  while :; do
    tw=$(tw_count)
    [ $((RANGE - tw)) -ge "$NEED" ] && break
    [ "$i" -ge 45 ] && { echo "[test-batches] 等 90s 後 TIME_WAIT 仍有 $tw，照跑"; break; }
    [ "$i" -eq 0 ] && echo "[test-batches] TIME_WAIT $tw／port 範圍 $RANGE，等可用 port ≥ $NEED…"
    i=$((i + 1)); sleep 2
  done
}

PASSED_FILES=0
PASSED_TESTS=0
FAILED=()
T0=$(date +%s)

for ((b = 0; b < NB; b++)); do
  chunk=("${FILES[@]:b*BATCH:BATCH}")
  n=${#chunk[@]}
  label="[$((b + 1))/$NB]"
  [ -n "$GH" ] && echo "::group::$label ${chunk[*]}"
  [ -z "$GH" ] && echo "$label ${chunk[*]}"
  wait_for_ports
  t0=$(date +%s)
  npx vitest run "${chunk[@]}" 2>&1 | tee "$LOG" | { [ -n "$GH" ] && cat || cat >/dev/null; }
  code=${PIPESTATUS[0]}
  t1=$(date +%s)
  [ -n "$GH" ] && echo "::endgroup::"

  plain="$(sed -E 's/\x1b\[[0-9;]*m//g' "$LOG")"
  files_line="$(grep -E '^ *Test Files ' <<<"$plain" | tail -1 | sed -E 's/^ +//')"
  # 統計行是「Tests」後兩個空白；只一個空白的是 "Tests closed successfully but…" 之類的訊息
  tests_line="$(grep -E '^ *Tests  ' <<<"$plain" | tail -1 | sed -E 's/^ +//')"
  if [ "$code" -eq 0 ] && grep -qE "^Test Files +$n passed \($n\)$" <<<"$files_line"; then
    PASSED_FILES=$((PASSED_FILES + n))
    t="$(sed -nE 's/^Tests +([0-9]+) passed.*/\1/p' <<<"$tests_line")"
    PASSED_TESTS=$((PASSED_TESTS + ${t:-0}))
    echo "$label PASS $((t1 - t0))s｜$files_line｜$tests_line"
  else
    FAILED+=("$label")
    echo "$label FAIL $((t1 - t0))s（vitest exit=$code）｜${files_line:-沒有 Test Files 統計}｜$tests_line"
    echo "── $label 檔案：${chunk[*]}"
    echo "── $label 各檔結果："
    grep -E '^ *(✓|❯|×|↓) ' <<<"$plain" | head -20
    echo "── $label 錯誤摘要："
    if grep -qE '^ *(FAIL|×) |Error: ' <<<"$plain"; then
      grep -E -A6 '^ *(FAIL|×) |Error: ' <<<"$plain" | head -60
    else
      tail -30 <<<"$plain"
    fi
    [ -n "$GH" ] && echo "::error::test-batches $label 失敗（vitest exit=$code）：${chunk[*]}"
  fi
done

T1=$(date +%s)
echo ""
echo "[test-batches] 檔案 $PASSED_FILES/$TOTAL 通過、測試 $PASSED_TESTS 則通過、失敗批次 ${#FAILED[@]}/$NB（${FAILED[*]:-無}）、耗時 $((T1 - T0))s"
if [ "${#FAILED[@]}" -ne 0 ] || [ "$PASSED_FILES" -ne "$TOTAL" ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
