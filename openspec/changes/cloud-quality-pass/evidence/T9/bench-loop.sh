#!/usr/bin/env bash
# Loop delay of an isolated test server with N re-adopted scripts and the status panel open.
# Usage: bench-loop.sh <repo-dir> <label> [N=20]
# Prints one JSON line: label, uptime, readopted count, status polls, ELD p50/p90/p99/max (ms).
set -u
REPO=$1; LABEL=$2; N=${3:-20}
B=$(cd "$(dirname "$0")" && pwd)
PORT=${BENCH_PORT:-13391}
D=$B/data-$LABEL
rm -rf "$D"; mkdir -p "$D/.state/scripts"
export PATH=/opt/node20/bin:$PATH

# N long-lived processes, outside the server's tree (setsid), stamped like the registry stamps them.
PIDS=()
ROWS=""
for i in $(seq 1 "$N"); do
  setsid sleep 900 >/dev/null 2>&1 < /dev/null &
  pid=$!
  PIDS+=("$pid")
done
sleep 0.3
for pid in "${PIDS[@]}"; do
  lstart=$(ps -o lstart= -p "$pid" | sed 's/^ *//;s/ *$//')
  ROWS+="{\"processId\":\"bench-$pid\",\"scriptName\":\"bench-$pid\",\"command\":\"sleep 900\",\"projectPath\":\"$D\",\"status\":\"running\",\"pid\":$pid,\"pidLstart\":\"$lstart\",\"startedAt\":\"$(date -u +%FT%TZ)\"},"
done
echo "{\"running\":[${ROWS%,}],\"recent\":[]}" > "$D/.state/scripts.json"

cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  # The next run must find the port free (graceful shutdown takes a moment).
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/version" || break; sleep 0.5; done
  [ -n "${SRV:-}" ] && kill -9 "$SRV" 2>/dev/null
}
trap cleanup EXIT

# The repo's own launcher, with the server started under the preload (BUN_OPTIONS breaks `bun run`).
REPO_ABS=$(cd "$REPO" && pwd)
sed -e "s|^REPO_ROOT=.*|REPO_ROOT=\"$REPO_ABS\"|" \
    -e "s|^exec bun run server.ts|exec bun --preload=$B/eld-preload.ts server.ts|" \
    "$REPO/scripts/start-test-server.sh" > "$D/launch.sh"
(DATA_DIR="$D" BUN_PORT=$PORT NO_TLS=1 SERVER_HOST=127.0.0.1 \
  ELD_OUT="$D/eld.json" ELD_STALLS="${TRACE:+$D/stalls.log}" ELD_WARMUP_MS=${WARMUP_MS:-20000} ELD_WINDOW_MS=${WINDOW_MS:-60000} \
  exec bash "$D/launch.sh" > "$D/server.log" 2>&1) &
SRV=$!

URL=http://127.0.0.1:$PORT
H="x-gateway-token: test-token"
for _ in $(seq 1 120); do
  curl -sf -H "$H" "$URL/api/version" >/dev/null 2>&1 && break
  sleep 0.5
done
READOPTED=$(curl -s -H "$H" "$URL/api/scripts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.running??j.scripts??[]);console.log(a.filter(x=>String(x.processId||"").startsWith("bench-")&&x.status==="running").length)}catch{console.log("?")}})')
# The status panel open (PerfSection polls every 3 s) until the window is written.
POLLS=0
while [ ! -s "$D/eld.json" ]; do
  if [ "${STATUS_POLL:-1}" = 1 ]; then echo "$(date +%s%3N) status" >> "$D/polls.log"; curl -s -o /dev/null -H "$H" "$URL/api/system/status"; fi; POLLS=$((POLLS+1))
  sleep 3
  [ $POLLS -gt 60 ] && break
done
ALIVE_AT_END=$(curl -s -H "$H" "$URL/api/scripts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.running??j.scripts??[]);console.log(a.filter(x=>String(x.processId||"").startsWith("bench-")&&x.status==="running").length)}catch{console.log("?")}})')
echo "{\"label\":\"$LABEL\",\"uptime\":\"$(uptime | sed 's/.*load average: //')\",\"readopted\":\"$READOPTED\",\"aliveAtEnd\":\"$ALIVE_AT_END\",\"polls\":$POLLS,\"eld\":$(cat "$D/eld.json" 2>/dev/null || echo null)}"
