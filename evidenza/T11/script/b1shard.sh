#!/usr/bin/env bash
# B1 di T11, carico L3: `bun run test:unit:shards` (4 shard) che gira in parallelo
# come carico, e il test ripetuto N volte accanto, nello stesso albero.
# Uso: b1shard.sh <etichetta> <test...>   test = 1, 2, 3
set -u
cd "${REPO:-/home/user/topics-app}"
export PATH=/opt/node20/bin:$PATH
LABEL=$1; shift
N1=${N1:-30}
L=/tmp/claude-0/-home-user-topics-app/9eb862f0-ca18-56b3-9aa9-f42b30337175/scratchpad/logs/b1shard-$LABEL
mkdir -p "$L"
S="$L/summary.txt"
# The load: the four shards, forced to 4 so the count does not move with the load.
TOPICS_UNIT_SHARDS=4 bun run scripts/test-unit-shards.ts > "$L/shards-load.log" 2>&1 &
LOADPID=$!
trap 'kill $LOADPID 2>/dev/null; pkill -P $LOADPID 2>/dev/null' EXIT
sleep 30
echo "HEAD $(git rev-parse --short HEAD) bun $(bun --version) load=test:unit:shards x4 in parallel N1=$N1" >> "$S"

unit() { # unit <id> <bun test args...>
  local id=$1; shift
  local red=0
  echo "== T$id start $(date -u +%T) uptime: $(uptime)" >> "$S"
  for k in $(seq 1 "$N1"); do
    if ! bun test --timeout 30000 "$@" > "$L/t$id-run$k.log" 2>&1; then
      red=$((red+1)); echo "   T$id run $k RED $(date -u +%T)" >> "$S"
    else rm -f "$L/t$id-run$k.log"; fi
  done
  echo "== T$id red=$red/$N1 end $(date -u +%T) uptime: $(uptime) shards-alive=$(kill -0 $LOADPID 2>/dev/null && echo yes || echo no)" >> "$S"
}

for t in "$@"; do
  case $t in
    1) unit 1 tests/integration/terminal-revive-race.test.ts ;;
    2) unit 2 tests/integration/subagent-native-engine.test.ts ;;
    3) unit 3 server/services/ci-evidence.test.ts -t spawnCapped ;;
  esac
done
echo DONE >> "$S"
