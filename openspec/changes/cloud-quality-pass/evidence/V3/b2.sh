#!/usr/bin/env bash
# V3 B2: one number per track, base and head alternated, PAIRS pairs.
# Usage: b2.sh <metric> [pairs=3]   metrics: ink first-frame cls renders boot routes branches loop qa
set -u
M=$1; PAIRS=${2:-3}
export PATH=/opt/node20/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright SERVER_HOST=127.0.0.1
O=/tmp/v3/b2; mkdir -p $O
load() { cut -d' ' -f1-3 /proc/loadavg; }
run() {
  local side=$1 i=$2 W=/home/user/v3-$1
  local port; [ $side = base ] && port=13810 || port=13820
  local tag="$M $side $i load=[$(load)]"
  cd $W
  case $M in
    ink)
      E2E_PORT=$port bun run check:ink > $O/ink-$side-$i.log 2>&1; ec=$?
      echo "$tag exit=$ec $(node -e 'const j=require("'$W'/test-results/ink-latency.json");const g=j.gestures||j;console.log(JSON.stringify(Object.fromEntries(Object.entries(g).filter(([k])=>["card","tab","send"].includes(k)).map(([k,v])=>[k,v.medianMs]))))' 2>/dev/null)" ;;
    first-frame)
      E2E_PORT=$port E2E_TIER=pr npx playwright test tests/e2e/topic-visited-first-frame.spec.ts -g "al ricarico" --project=chromium --retries=0 --reporter=line > $O/ff-$side-$i.log 2>&1; ec=$?
      seq=$(grep -o "\[topic-first-frame\] seq=[^ ]*" $O/ff-$side-$i.log | head -1 | sed 's/.*seq=//')
      sk=$(echo "$seq" | sed 's/^-*//' | grep -o '^S*' | tr -d '\n' | wc -c)
      echo "$tag exit=$ec skeletonFrames=$sk seq=${seq:0:40}" ;;
    cls)
      E2E_PORT=$port E2E_TIER=pr npx playwright test tests/e2e/chat-image-box.spec.ts tests/e2e/topic-visited-first-frame.spec.ts -g "immagine" --project=chromium --retries=0 --reporter=line > $O/cls-$side-$i.log 2>&1; ec=$?
      echo "$tag exit=$ec $(grep -oE '\[(chat-image-box:[a-z]+|topic-first-frame:away-image)\][^\n]*CLS=[0-9.]+' $O/cls-$side-$i.log | sed -E 's/held=[^ ]* //;s/picture=[^ ]* //;s/sized=[^ ]* //' | tr '\n' ' ')" ;;
    renders)
      E2E_PORT=$port npx playwright test tests/e2e/board-update-renders.spec.ts --project=chromium --retries=0 --reporter=line > $O/renders-$side-$i.log 2>&1; ec=$?
      echo "$tag exit=$ec $(node -e 'const j=require("'$W'/test-results/board-update-renders.json");console.log(JSON.stringify({r:j.rendersPerFrame,layout:j.layoutRendersPerFrame,pane:j.paneRendersPerFrame}))' 2>/dev/null)" ;;
    boot)
      echo "$tag $(bash /tmp/v3/boot-time.sh $W $side 5 warm 13481) $(bash /tmp/v3/boot-time.sh $W $side 5 fresh 13482)" ;;
    routes)
      echo "$tag $(bun /tmp/v3/bench-routes.ts $W $side 13471 2>&1 | tail -1)" ;;
    branches)
      (cd /tmp/v3/t9 && echo "$tag $(bun bench-branches.ts $W $side-$i 40 2>&1 | tail -1)") ;;
    loop)
      echo "$tag $(BENCH_PORT=13391 bash /tmp/v3/t9/bench-loop.sh $W $side-$i 20 2>&1 | tail -1)" ;;
    qa)
      rm -rf .cache/checks; s=$(date +%s%N); ./scripts/qa-gate.sh --veloce > $O/qa-$side-$i.log 2>&1; ec=$?
      echo "$tag exit=$ec seconds=$(( ($(date +%s%N)-s)/1000000000 ))" ;;
  esac
}
for i in $(seq 1 $PAIRS); do
  for side in base head; do run $side $i >> $O/$M.txt; sleep 3; done
done
echo "$M DONE" >> $O/$M.txt
