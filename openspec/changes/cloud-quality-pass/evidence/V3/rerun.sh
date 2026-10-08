#!/usr/bin/env bash
# V3 B1: a test red/flaky only on head, re-run alone 3 times on each side. Usage: rerun.sh <spec[:line]> <tag>
export PATH=/opt/node20/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright SERVER_HOST=127.0.0.1 E2E_TIER=pr
for i in 1 2 3; do for side in head base; do
  cd /home/user/v3-$side
  [ $side = base ] && port=13830 || port=13840
  E2E_PORT=$port npx playwright test "tests/e2e/$1" --project=chromium --retries=0 --reporter=line > /tmp/v3/rerun-$2-$side-$i.log 2>&1
  echo "$2 $side $i exit=$? load=[$(cut -d' ' -f1-3 /proc/loadavg)] $(grep -oE '[0-9]+ (passed|failed|flaky)' /tmp/v3/rerun-$2-$side-$i.log | tr '\n' ' ')" >> /tmp/v3/rerun.txt
done; done
