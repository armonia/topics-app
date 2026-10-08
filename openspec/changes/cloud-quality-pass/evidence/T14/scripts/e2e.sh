export PATH=/opt/node20/bin:$PATH
export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright
cd /home/user/topics-app
S=/tmp/claude-0/-home-user-topics-app/2b119615-6f17-574c-b329-77893cf501ff/scratchpad
SPECS="tests/e2e/board-land-conflict.spec.ts tests/e2e/board-landing-honesty.spec.ts tests/e2e/board-card-landing-receipt.spec.ts tests/e2e/chat-changed-files-task-range.spec.ts"
run() { local tag=$1; rm -rf test-results; local s=$(date +%s)
  E2E_TIER=pr E2E_EVIDENCE=1 E2E_VIDEO=1 npx playwright test --project=chromium $SPECS > $S/e2e-$tag.log 2>&1; local rc=$?
  echo "$tag EXIT=$rc secs=$(( $(date +%s)-s )) $(git rev-parse --short HEAD) $(uptime)"
  rm -rf $S/evidenza-$tag; mkdir -p $S/evidenza-$tag; find test-results -name "*.webm" -o -name "trace.zip" | while read f; do d=$S/evidenza-$tag/$(dirname "$f" | sed 's|test-results/artifacts/||'); mkdir -p "$d"; cp "$f" "$d/"; done; }
git checkout -q --detach d99bc03 && run prima
git checkout -q cloud/t14-run-bounded && run dopo
git status --short | head
