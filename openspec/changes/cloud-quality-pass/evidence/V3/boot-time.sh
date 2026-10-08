#!/usr/bin/env bash
# V3 B2 · T3: server start -> first 200 on `/`, isolated test server.
# Usage: boot-time.sh <repo-dir> <label> <boots> <fresh|warm> [port]
# fresh: a new DATA_DIR per boot; warm: the same one, initialised by a first boot not counted.
set -u
REPO=$1; LABEL=$2; N=$3; MODE=$4; PORT=${5:-13481}
D=/tmp/v3-boot-$PORT
rm -rf "$D"*
boot() {
  local dir=$1
  local t0=$(date +%s%N)
  (cd "$REPO" && DATA_DIR="$dir" BUN_PORT=$PORT NO_TLS=1 SERVER_HOST=127.0.0.1 TOPICS_E2E=1 \
     TOPICS_PTY_SOCKET=/tmp/v3-boot-pty-$PORT.sock TOPICS_AI_BRIDGE_SOCKET=/tmp/v3-boot-ai-$PORT.sock \
     setsid bash scripts/start-test-server.sh >"$dir.log" 2>&1) &
  local pid=$!
  local ms=""
  for _ in $(seq 1 600); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)
    if [ "$code" = "200" ]; then ms=$(( ($(date +%s%N)-t0)/1000000 )); break; fi
    sleep 0.01
  done
  # The server is the leader of its own group (setsid + exec): find it by its DATA_DIR, never by our own group.
  for p in $(pgrep -f "started-by=start-test-server"); do
    tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx "DATA_DIR=$dir" && kill -TERM -$p 2>/dev/null
  done
  for _ in $(seq 1 100); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null || break; sleep 0.1; done
  echo "${ms:-NA}"
}
if [ "$MODE" = warm ]; then mkdir -p $D-warm; boot $D-warm >/dev/null; fi
T=()
for i in $(seq 1 "$N"); do
  if [ "$MODE" = warm ]; then dir=$D-warm; else dir=$D-$i; mkdir -p "$dir"; fi
  T+=("$(boot "$dir")")
done
med=$(printf '%s\n' "${T[@]}" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}')
echo "{\"label\":\"$LABEL\",\"mode\":\"$MODE\",\"boots\":\"${T[*]}\",\"median_ms\":$med,\"load1\":\"$(cut -d' ' -f1 /proc/loadavg)\"}"
rm -rf "$D"*
