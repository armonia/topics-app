#!/usr/bin/env bash
# V3 B1 chain: waits for b1 base, then e2e base, b1 head, e2e head, unit on Bun 1.3.8 (base, head).
set -u
until grep -q DONE /tmp/v3/b1-base/summary 2>/dev/null; do sleep 10; done
/tmp/v3/e2e.sh base
/tmp/v3/b1.sh head
/tmp/v3/e2e.sh head
export PATH=/opt/node20/bin:$PATH
for side in base head; do
  L=/tmp/v3/b1-$side
  s=$(date +%s)
  (cd /home/user/v3-$side && PATH=/tmp/bun138/node_modules/.bin:$PATH bun run test:unit:shards > $L/unit138.log 2>&1; echo "unit138 $? $(( $(date +%s)-s ))s $(uptime)" >> $L/summary)
done
echo CHAIN-DONE >> /tmp/v3/chain.log
