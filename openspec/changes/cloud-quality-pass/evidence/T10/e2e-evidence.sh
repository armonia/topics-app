#!/usr/bin/env bash
# BASE then HEAD: the T10 feed-calls measurement plus the board feed specs, with video.
S=/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad
export PATH=/opt/node20/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright SERVER_HOST=127.0.0.1
for side in ${SIDES:-base head}; do
  case $side in base) repo=$S/base ;; head) repo=/home/user/topics-app ;; esac
  cp $S/bench/board-t10-feed-calls.spec.ts $repo/tests/e2e/
  echo "== $side $(uptime)"
  (cd $repo && E2E_EVIDENCE=1 E2E_VIDEO=1 npx playwright test --project=chromium \
     tests/e2e/board-t10-feed-calls.spec.ts tests/e2e/board-feed-reads.spec.ts tests/e2e/board-recapture-preview.spec.ts \
     --output=$S/evidence/$side --reporter=line > $S/evidence-$side.log 2>&1; echo "$side EXIT=$?")
  rm -f $repo/tests/e2e/board-t10-feed-calls.spec.ts
  grep -aE "T10-FEED-CALLS|[0-9]+ (passed|failed|flaky|skipped)" $S/evidence-$side.log | grep -v "test-server" | tail -5
done
