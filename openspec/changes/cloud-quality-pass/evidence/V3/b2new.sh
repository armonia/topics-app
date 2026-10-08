#!/usr/bin/env bash
# V3 B2 on the new head 7a27c71: T8 renders per move, T7b CLS of the sender's bubble, T2b card age (pass/fail).
until grep -q NEW-DONE /tmp/v3/chain.log 2>/dev/null; do sleep 10; done
export PATH=/opt/node20/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright SERVER_HOST=127.0.0.1
O=/tmp/v3/b2; for i in 1 2 3; do for side in base new; do
  W=/home/user/v3-$side; cd $W; [ $side = base ] && port=13810 || port=13830
  l="load=[$(cut -d' ' -f1 /proc/loadavg)]"
  E2E_PORT=$port npx playwright test tests/e2e/board-drag-renders.spec.ts --project=chromium --retries=0 --reporter=line > $O/drag-$side-$i.log 2>&1; e1=$?
  d=$(node -e 'const j=require("'$W'/test-results/board-drag-renders.json");console.log(JSON.stringify(j.median))' 2>/dev/null)
  E2E_PORT=$port E2E_TIER=pr npx playwright test tests/e2e/chat-image-box.spec.ts -g "bolla di chi allega" --project=chromium --retries=0 --reporter=line > $O/own-$side-$i.log 2>&1; e2=$?
  c=$(grep -oE "\[chat-image-box:own\][^\n]*CLS=[0-9.]+" $O/own-$side-$i.log | grep -oE "CLS=[0-9.]+")
  E2E_PORT=$port E2E_TIER=pr npx playwright test tests/e2e/board-card-updated-ago.spec.ts --project=chromium --retries=0 --reporter=line > $O/ago-$side-$i.log 2>&1; e3=$?
  echo "new $side $i $l drag(exit=$e1)=$d own(exit=$e2)=$c ago(exit=$e3)=$(grep -oE '[0-9]+ (passed|failed)' $O/ago-$side-$i.log | tr '\n' ' ')" >> $O/b2new.txt
done; done
echo "b2new DONE" >> $O/b2new.txt
