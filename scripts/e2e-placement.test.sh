#!/usr/bin/env bash
# Bar of scripts/e2e-placement.sh. Exit 0 = every case holds.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
p="$here/e2e-placement.sh"
fail=0
check() {
  local name=$1 want=$2; shift 2
  local got; got=$(bash "$p" "$@")
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: got $got want $want"; fail=1; fi
}

PR='[0,1,2,3,4,5,6,7,8]'
PUSH='[1,2,3,4,5,6,7,8]'
check "nothing self-hosted: every shard on GitHub" '{}' "$PR" "" 0 "" 0
check "PC 4 + Hetzner 4: the long shards off GitHub, shard 0 stays" \
  '{"s1":"pc-9-1","s2":"pc-9-1","s3":"pc-9-1","s4":"pc-9-1","s5":"gh-runner-9-1","s6":"gh-runner-9-1","s7":"gh-runner-9-1","s8":"gh-runner-9-1"}' \
  "$PR" pc-9-1 4 gh-runner-9-1 4
check "Hetzner only, 4 runners: shards 1-4" \
  '{"s1":"gh","s2":"gh","s3":"gh","s4":"gh"}' "$PUSH" "" 0 gh 4
check "never more shards than runners: 3 online, 3 shards" \
  '{"s1":"gh","s2":"gh","s3":"gh"}' "$PUSH" "" 0 gh 3
check "PC with no label counts zero" '{"s1":"gh"}' "$PUSH" "" 4 gh 1
check "garbage count counts zero" '{}' "$PUSH" pc abc "" 0
check "enough slots for all nine: shard 0 last" \
  '{"s1":"pc","s2":"pc","s3":"pc","s4":"pc","s5":"pc","s6":"gh","s7":"gh","s8":"gh","s0":"gh"}' "$PR" pc 5 gh 4
check "nothing changed: the single shard 0" '{"s0":"pc"}' '[0]' pc 4 "" 0
check "a prep runner online takes prepare-e2e" '{"s1":"gh","prep":"gh-prep"}' "$PUSH" "" 0 gh 1 gh-prep
check "no prep runner: prepare-e2e stays on GitHub" '{"s1":"gh"}' "$PUSH" "" 0 gh 1 ""

# Mutation: if the cap were dropped (every shard on the first label) the
# 3-runner case above must go red.
mut=$(sed 's/if \$i < \$pn then/if true then/' "$p")
got=$(bash -c "$mut" _ "$PUSH" pc 1 "" 0)
if [ "$got" = '{"s1":"pc"}' ]; then echo "FAIL mutation survived"; fail=1; else echo "ok   mutation (no cap) is caught"; fi
exit $fail
