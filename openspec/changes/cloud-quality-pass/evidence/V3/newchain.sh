#!/usr/bin/env bash
/tmp/v3/b1.sh new
/tmp/v3/e2e.sh new
export PATH=/opt/node20/bin:$PATH
L=/tmp/v3/b1-new; s=$(date +%s)
(cd /home/user/v3-new && PATH=/tmp/bun138/node_modules/.bin:$PATH bun run test:unit:shards > $L/unit138.log 2>&1; echo "unit138 $? $(( $(date +%s)-s ))s $(uptime)" >> $L/summary)
echo NEW-DONE >> /tmp/v3/chain.log
