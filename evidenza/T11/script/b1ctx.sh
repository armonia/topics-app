#!/usr/bin/env bash
# B1 di T11, carico L2: stesso carico di b1.sh (4 x `yes`) PIU' il contesto dello
# shard: il test gira nello stesso processo `bun test` dopo i file che lo
# precedono nel suo shard e toccano il bridge (bun non isola i file).
# Uso: b1ctx.sh <etichetta> <test...>   test = 1, 2, 3
set -u
cd /home/user/topics-app
export PATH=/opt/node20/bin:$PATH
LABEL=$1; shift
N1=${N1:-30}
L=/tmp/claude-0/-home-user-topics-app/9eb862f0-ca18-56b3-9aa9-f42b30337175/scratchpad/logs/b1ctx-$LABEL
mkdir -p "$L"
S="$L/summary.txt"
PIDS=()
for i in 1 2 3 4; do yes > /dev/null & PIDS+=($!); done
trap 'kill ${PIDS[@]} 2>/dev/null' EXIT
sleep 5
echo "HEAD $(git rev-parse --short HEAD) bun $(bun --version) load=4x yes + shard context N1=$N1" >> "$S"

ctx() { # ctx <id> <target file> <files in order...>
  local id=$1 target=$2; shift 2
  local red=0
  echo "== T$id start $(date -u +%T) files: $* uptime: $(uptime)" >> "$S"
  for k in $(seq 1 "$N1"); do
    bun test --timeout 30000 "$@" > "$L/t$id-run$k.log" 2>&1
    # Red only if a test of the TARGET file failed (the others are context).
    if awk -v t="$target" '/^[^ ].*\.test\.ts:$/{cur=$0} /^\(fail\)/{ if (index(cur, t)) bad=1 } END{exit !bad}' "$L/t$id-run$k.log"; then
      red=$((red+1)); echo "   T$id run $k RED" >> "$S"
    elif grep -q "^\(fail\)" "$L/t$id-run$k.log"; then
      echo "   T$id run $k (fail in a context file only)" >> "$S"
    else rm -f "$L/t$id-run$k.log"; fi
  done
  echo "== T$id red=$red/$N1 end $(date -u +%T) uptime: $(uptime)" >> "$S"
}

for t in "$@"; do
  case $t in
    # Shard order with 2 shards (the count the runner picks under load):
    # these are the bridge files before the target, in that order.
    1) ctx 1 tests/integration/terminal-revive-race.test.ts \
         tests/integration/live-phase-gate.test.ts server/services/deliveryReportChecks.test.ts \
         tests/integration/terminal-input-dropped.test.ts tests/integration/terminal-revive-race.test.ts ;;
    2) ctx 2 tests/integration/subagent-native-engine.test.ts \
         tests/integration/terminal-input-dropped.test.ts server/lib/ai-bridge-socket-error.test.ts \
         server/services/ci-evidence.test.ts tests/integration/subagent-native-engine.test.ts ;;
    3) ctx 3 server/services/ci-evidence.test.ts \
         tests/integration/terminal-input-dropped.test.ts server/lib/ai-bridge-socket-error.test.ts \
         server/services/ci-evidence.test.ts ;;
  esac
done
echo DONE >> "$S"
