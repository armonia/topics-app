#!/usr/bin/env bash
# T12 bar, the same at start and end. Usage: bar.sh <worktree> <label> [main-worktree-for-1.3.8-compare]
# Logs in $SP/bar-<label>/. One step at a time (no parallel heavy work).
set -u
W=$1; LABEL=$2; MAINW=${3:-}
SP=/tmp/claude-0/-home-user-topics-app/affbdc18-0dbd-502d-80eb-3382b653a1e1/scratchpad
L=$SP/bar-$LABEL; rm -rf $L; mkdir -p $L
export PATH=/opt/node20/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright SERVER_HOST=127.0.0.1
B138=/tmp/bun138/node_modules/.bin
step() { local name=$1; shift; local s=$(date +%s); ( cd $W && "$@" ) > $L/$name.log 2>&1; local rc=$?; echo "$name exit=$rc secs=$(( $(date +%s)-s )) load=[$(cut -d' ' -f1-3 /proc/loadavg)]" >> $L/summary; }
echo "start $(date -u +%FT%TZ) $(git -C $W rev-parse --short HEAD) $(uptime)" > $L/summary
step b1-d1-test-138 $B138/bun test server/db/v3-embedded-fallback-fresh-process.test.ts server/db/embedded-fallback-fresh-process.test.ts
step b1-d1-test-latest bun test server/db/v3-embedded-fallback-fresh-process.test.ts server/db/embedded-fallback-fresh-process.test.ts
step b2-d2-test bun test server/v3-guest-media-sizes.test.ts server/guest-media-sizes.test.ts
step qa ./scripts/qa-gate.sh --veloce
step unit-latest bun run test:unit:shards
step build bash -c 'bun run build:client && bun run check:bundle'
step e2e env E2E_TIER=pr npx playwright test --project=chromium --reporter=line tests/e2e/chat-accordion-no-shift.spec.ts tests/e2e/chat-media-placement.spec.ts tests/e2e/guest-confinement.spec.ts
step smoke-latest bash scripts/build-server-sidecar.sh smoke
step smoke-138 env PATH=$B138:$PATH bash scripts/build-server-sidecar.sh smoke
step unit-138 env PATH=$B138:$PATH bun run test:unit:shards
if [ -n "$MAINW" ]; then
  s=$(date +%s); ( cd $MAINW && PATH=$B138:$PATH bun run test:unit:shards ) > $L/unit-138-main.log 2>&1
  echo "unit-138-main exit=$? secs=$(( $(date +%s)-s )) load=[$(cut -d' ' -f1-3 /proc/loadavg)]" >> $L/summary
fi
git -C $W status --short > $L/git-status.txt
echo "DONE $(date -u +%FT%TZ) $(uptime)" >> $L/summary
