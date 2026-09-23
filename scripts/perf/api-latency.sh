#!/usr/bin/env bash
# 正式站 API 往返基準（不需登入的三支端點）。量的是「這台機器 → 邊緣 → worker」的純往返，
# 用來判斷某次開機變快/變慢是不是網路本身漂移（對照組）。
# 用法：bash scripts/perf/api-latency.sh [樣本數，預設 15]
set -u
N="${1:-15}"
BASE=https://mail.miseroda.com/api/v1
for ep in health auth/config auth/me; do
  for i in $(seq 1 "$N"); do curl -s -o /dev/null -w "%{time_starttransfer}\n" "$BASE/$ep"; done |
    sort -n | awk -v ep="$ep" '{a[NR]=$1*1000} END{printf "%-12s n=%d min=%.0f p50=%.0f max=%.0f ms（每次新連線，含 TLS）\n", ep, NR, a[1], a[int((NR+1)/2)], a[NR]}'
done
ray=$(curl -sI "$BASE/health" | tr -d '\r' | awk -F': ' 'tolower($1)=="cf-ray"{print $2} tolower($1)=="cf-placement"{print "placement=" $2}' | tr '\n' ' ')
echo "邊緣/放置：$ray（cf-ray 尾碼＝邊緣機房；絕對毫秒只在同一機房之間可比）"
