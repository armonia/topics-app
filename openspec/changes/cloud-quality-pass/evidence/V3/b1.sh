#!/usr/bin/env bash
# usage: b1.sh <base|head>
set -u
W=/home/user/v3-$1; L=/tmp/v3/b1-$1; mkdir -p $L
export PATH=/opt/node20/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
cd $W
s=$(date +%s); ./scripts/qa-gate.sh --veloce >$L/qa.log 2>&1; echo "qa $? $(( $(date +%s)-s ))s $(uptime)" >>$L/summary
s=$(date +%s); bun run test:unit:shards >$L/unit.log 2>&1; echo "unit $? $(( $(date +%s)-s ))s $(uptime)" >>$L/summary
s=$(date +%s); bun run build:client >$L/build.log 2>&1; echo "build $? $(( $(date +%s)-s ))s" >>$L/summary
s=$(date +%s); bun run check:bundle >$L/bundle.log 2>&1; echo "bundle $? $(( $(date +%s)-s ))s" >>$L/summary
echo DONE >>$L/summary
