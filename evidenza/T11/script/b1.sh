#!/usr/bin/env bash
# B1 di T11: ogni test instabile ripetuto N volte sotto lo stesso carico.
# Carico: 4 processi `yes > /dev/null` (uno per vCPU), accesi per tutta la corsa.
# Uso: b1.sh <etichetta> <test...>   test = 1..6, N1 = ripetizioni unit/integrazione, NE = e2e
set -u
cd "${REPO:-/home/user/topics-app}"
export PATH=/opt/node20/bin:$PATH
export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright
LABEL=$1; shift
N1=${N1:-30}; NE=${NE:-20}
L=/tmp/claude-0/-home-user-topics-app/9eb862f0-ca18-56b3-9aa9-f42b30337175/scratchpad/logs/b1-$LABEL
mkdir -p "$L"
S="$L/summary.txt"
PIDS=()
for i in 1 2 3 4; do yes > /dev/null & PIDS+=($!); done
trap 'kill ${PIDS[@]} 2>/dev/null' EXIT
sleep 5
echo "HEAD $(git rev-parse --short HEAD) bun $(bun --version) load=4x yes N1=$N1 NE=$NE" >> "$S"

unit() { # unit <id> <N> <bun test args...>
  local id=$1 n=$2; shift 2
  local red=0
  echo "== T$id start $(date -u +%T) uptime: $(uptime)" >> "$S"
  for k in $(seq 1 "$n"); do
    if ! bun test "$@" > "$L/t$id-run$k.log" 2>&1; then
      red=$((red+1)); echo "   T$id run $k RED" >> "$S"
    else rm -f "$L/t$id-run$k.log"; fi
  done
  echo "== T$id red=$red/$n end $(date -u +%T) uptime: $(uptime)" >> "$S"
}
e2e() { # e2e <id> <N> <spec[:line]> [extra args]
  local id=$1 n=$2 spec=$3; shift 3
  echo "== T$id start $(date -u +%T) uptime: $(uptime)" >> "$S"
  TOPICS_E2E_BUNDLE_DIR=${BUNDLE:-}   SERVER_HOST=127.0.0.1 E2E_TIER=pr npx playwright test --project=chromium "$spec" "$@" \
    --repeat-each "$n" --retries=0 --reporter=list --output "$L/t$id-results" > "$L/t$id.log" 2>&1
  local rc=$?
  local passed failed flaky
  passed=$(grep -Eo '[0-9]+ passed' "$L/t$id.log" | tail -1)
  failed=$(grep -Eo '[0-9]+ failed' "$L/t$id.log" | tail -1)
  echo "== T$id exit=$rc ${passed:-0 passed} ${failed:-0 failed} end $(date -u +%T) uptime: $(uptime)" >> "$S"
}

for t in "$@"; do
  case $t in
    1) unit 1 "$N1" tests/integration/terminal-revive-race.test.ts ;;
    2) unit 2 "$N1" tests/integration/subagent-native-engine.test.ts ;;
    3) unit 3 "$N1" server/services/ci-evidence.test.ts -t spawnCapped ;;
    4) e2e 4 "$NE" tests/e2e/board-card-choices.spec.ts -g "quattro stati, quattro decisioni in un click" ;;
    5) e2e 5 "$NE" tests/e2e/chat-streaming-indicator.spec.ts -g "at the bottom the line comes and goes" ;;
    6) e2e 6 "$NE" tests/e2e/board-motion-contract.spec.ts -g "a redirected drop and a filter move nothing by layout" ;;
  esac
done
echo DONE >> "$S"
