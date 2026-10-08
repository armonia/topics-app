#!/usr/bin/env bash
# T12 · S: chat-accordion-no-shift «tool-result-clamp», head vs main (with the head's specs),
# load L1 (4 × `yes > /dev/null`, one per vCPU, on 5 s before the first run, off after the last),
# --retries=0, alternated blocks of BLK repetitions until N per side. Probe: V3 accordion-debug.patch.
# Usage: s-run.sh <N per side> <block>
set -u
N=${1:-40}; BLK=${2:-10}
SP=/tmp/claude-0/-home-user-topics-app/affbdc18-0dbd-502d-80eb-3382b653a1e1/scratchpad
L=$SP/s-runs; mkdir -p $L
export PATH=/opt/node20/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright SERVER_HOST=127.0.0.1 E2E_TIER=pr
YES=(); for i in 1 2 3 4; do yes > /dev/null & YES+=($!); done
trap 'kill ${YES[@]} 2>/dev/null' EXIT
sleep 5
echo "start $(date -u +%FT%TZ) N=$N BLK=$BLK $(uptime)" >> $L/summary
b=0
while [ $(( b * BLK )) -lt $N ]; do
  b=$((b+1))
  for side in head main; do
    W=/home/user/t12-${side}S
    s=$(date +%s)
    ( cd $W && npx playwright test --project=chromium --retries=0 --repeat-each=$BLK -g "tool-result-clamp" \
        --reporter=line tests/e2e/chat-accordion-no-shift.spec.ts ) > $L/$side-$b.log 2>&1
    rc=$?
    pass=$(grep -Eo '[0-9]+ passed' $L/$side-$b.log | tail -1); fail=$(grep -Eo '[0-9]+ failed' $L/$side-$b.log | tail -1)
    echo "$side block=$b exit=$rc ${pass:-0 passed} ${fail:-0 failed} secs=$(( $(date +%s)-s )) load=[$(cut -d' ' -f1-3 /proc/loadavg)]" >> $L/summary
  done
done
echo "DONE $(date -u +%FT%TZ) $(uptime)" >> $L/summary
