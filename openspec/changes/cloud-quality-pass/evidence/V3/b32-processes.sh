#!/usr/bin/env bash
# V3 B3.2: processes.ts on a real isolated server: re-adopted rows (T9 liveness),
# an external kill, a Stop, a zombie, and the server shutting down with live children.
# Usage: b32-processes.sh <repo-dir> <label> [port] [bun-bin-dir]
set -u
REPO=$1; LABEL=$2; PORT=${3:-13495}
[ -n "${4:-}" ] && export PATH=$4:$PATH
D=/tmp/v3-b32-$LABEL; rm -rf "$D"; mkdir -p "$D/.state"
H="x-gateway-token: test-token"; URL=http://127.0.0.1:$PORT
row() { echo "{\"processId\":\"v3-$1\",\"scriptName\":\"v3-$1\",\"command\":\"sleep 900\",\"projectPath\":\"$D\",\"status\":\"running\",\"pid\":$1,\"pidLstart\":\"$(ps -o lstart= -p $1 | sed 's/^ *//;s/ *$//')\",\"startedAt\":\"$(date -u +%FT%TZ)\"}"; }
setsid sleep 900 </dev/null >/dev/null 2>&1 & P1=$!
setsid sleep 900 </dev/null >/dev/null 2>&1 & P2=$!
setsid sleep 900 </dev/null >/dev/null 2>&1 & P4=$!
# A zombie: `sleep 0` exits under a parent (exec'd sleep 900) that never reaps it.
setsid sh -c 'sleep 0 & exec sleep 900' </dev/null >/dev/null 2>&1 & ZP=$!
sleep 0.5
Z=$(ps -o pid=,stat= --ppid $ZP | awk '$2 ~ /^Z/ {print $1}' | head -1)
echo "pids p1=$P1 p2=$P2 p4=$P4 zombie=$Z (parent $ZP) bun=$(bun --version)"
echo "{\"running\":[$(row $P1),$(row $P2),$(row $P4),$(row $Z)],\"recent\":[]}" > "$D/.state/scripts.json"
(cd "$REPO" && DATA_DIR="$D" BUN_PORT=$PORT NO_TLS=1 SERVER_HOST=127.0.0.1 \
  TOPICS_PTY_SOCKET=/tmp/v3-b32-pty-$PORT.sock TOPICS_AI_BRIDGE_SOCKET=/tmp/v3-b32-ai-$PORT.sock \
  setsid bash scripts/start-test-server.sh > "$D/server.log" 2>&1) &
srvpid() { for p in $(pgrep -f "started-by=start-test-server"); do tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx "DATA_DIR=$D" && echo $p; done; }
trap 'S=$(srvpid); [ -n "$S" ] && kill -KILL -$S 2>/dev/null; kill $P1 $P2 $P4 $ZP 2>/dev/null' EXIT
for _ in $(seq 1 200); do curl -sf -H "$H" "$URL/api/version" >/dev/null 2>&1 && break; sleep 0.25; done
SPID=$(srvpid); echo "server pid $SPID"
state() { curl -s -H "$H" "$URL/api/scripts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=(j.scripts||[]).filter(x=>String(x.processId).startsWith("v3-")&&x.status==="running").map(x=>x.processId+":"+x.status);console.log(r.sort().join(" ")||"-")})'; }
t0=$(date +%s%N); ms() { echo $(( ($(date +%s%N)-t0)/1000000 )); }
echo "boot: running=[$(state)]"
# 1. The zombie row must close by itself (it is not alive).
for _ in $(seq 1 40); do state | grep -q "v3-$Z:" || break; sleep 0.25; done
echo "zombie row closed after $(ms) ms: running=[$(state)]"
# 2. An external kill: the row closes within a round or two.
t0=$(date +%s%N); kill $P1
for _ in $(seq 1 60); do state | grep -q "v3-$P1:" || break; sleep 0.25; done
echo "killed p1 row closed after $(ms) ms: running=[$(state)]"
# 3. Stop from the panel.
t0=$(date +%s%N); code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" "$URL/api/scripts/v3-$P2/stop")
for _ in $(seq 1 60); do kill -0 $P2 2>/dev/null || break; sleep 0.25; done
echo "stop p2: http=$code, process gone=$([ -e /proc/$P2 ] && echo no || echo yes) after $(ms) ms; running=[$(state)]"
sleep 3.5; echo "stop p2 +3.5s: running=[$(state)]"
# 4. Shut down with p4 still alive and re-adopted: the server exits, p4 survives (it is re-adopted at the next boot).
t0=$(date +%s%N); kill -TERM -$SPID
for _ in $(seq 1 300); do kill -0 $SPID 2>/dev/null || break; sleep 0.1; done
echo "shutdown: server gone after $(ms) ms; p4 alive=$(kill -0 $P4 2>/dev/null && echo yes || echo no)"
grep -iE "pid-liveness|exit watch|error|uncaught" "$D/server.log" | grep -v "^\s*$" | head -5
kill $P4 $ZP 2>/dev/null; kill -9 $P2 2>/dev/null
