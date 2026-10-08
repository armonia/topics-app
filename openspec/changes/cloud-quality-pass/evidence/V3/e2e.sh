#!/usr/bin/env bash
# V3 B1: e2e of the area, Chromium, PR tier, two shards in parallel on their own ports.
# Usage: e2e.sh <base|head>
set -u
SIDE=$1; W=/home/user/v3-$SIDE; L=/tmp/v3/e2e-$SIDE; mkdir -p $L
export PATH=/opt/node20/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright SERVER_HOST=127.0.0.1 E2E_TIER=pr
cd $W/tests/e2e
SPECS=$(ls topic-*.spec.ts chat-*.spec.ts board-*.spec.ts task-*.spec.ts *cls*.spec.ts | sort -u | sed 's|^|tests/e2e/|')
cd $W
[ $SIDE = base ] && P=136 || P=137
s=$(date +%s)
for k in 1 2; do
  ( E2E_PORT=${P}${k}0 PLAYWRIGHT_JSON_OUTPUT_NAME=$L/shard$k.json npx playwright test --project=chromium --shard=$k/2 \
      --reporter=line,json --output=$L/out$k $SPECS > $L/shard$k.log 2>&1; echo "shard$k exit $?" >> $L/summary ) &
done
wait
echo "e2e $SIDE $(( $(date +%s)-s ))s $(uptime)" >> $L/summary
echo DONE >> $L/summary
