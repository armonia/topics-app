#!/usr/bin/env bash
# T10b e2e of the area: board-feed-reads.spec.ts, chromium, E2E_TIER=pr, with video.
# The isolated test server (:13334, tests/e2e/global-setup.ts) runs on the `bun` first on PATH.
# usage: run.sh <repoRoot> <bunBinDir> <tag>
set -u
S=/tmp/claude-0/-home-user-topics-app/b31c7c56-3b0f-5998-b893-910039f80563/scratchpad
REPO=$1; BIN=$2; TAG=$3
OUT=$S/e2e/$TAG
mkdir -p "$OUT"
cd "$REPO" || exit 9
export PATH="$BIN:/opt/node20/bin:$PATH"; hash -r
export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright SERVER_HOST=127.0.0.1 E2E_TIER=pr E2E_EVIDENCE=1 E2E_VIDEO=1
echo "== $TAG repo $REPO bun $(bun --version) $(uptime)" | tee "$OUT/summary"
npx playwright test --project=chromium tests/e2e/board-feed-reads.spec.ts --output="$OUT/results" > "$OUT/log" 2>&1; rc=$?
echo "exit $rc $(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)' "$OUT/log" | tr -s ' \n' ' ')" | tee -a "$OUT/summary"
grep -E '✘|\[chromium\].*›' "$OUT/log" | grep -E '✘|failed' | head -10 | tee -a "$OUT/summary"
echo "videos: $(find "$OUT/results" -name '*.webm' 2>/dev/null | wc -l)" | tee -a "$OUT/summary"
