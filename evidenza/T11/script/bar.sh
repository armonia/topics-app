#!/usr/bin/env bash
# La barra di T11 (B2), uguale all'inizio e alla fine. Uso: bar.sh <etichetta>
set -u
cd /home/user/topics-app
export PATH=/opt/node20/bin:$PATH
export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright
L=/tmp/claude-0/-home-user-topics-app/9eb862f0-ca18-56b3-9aa9-f42b30337175/scratchpad/logs/bar-$1
mkdir -p "$L"
step() {
  local name=$1; shift
  local t0=$(date +%s)
  echo "== $name start $(date -u +%T) uptime: $(uptime)" >> "$L/summary.txt"
  bash -c "$*" > "$L/$name.log" 2>&1
  local rc=$?
  echo "== $name exit=$rc $(( $(date +%s) - t0 ))s uptime: $(uptime)" >> "$L/summary.txt"
}
echo "HEAD $(git rev-parse --short HEAD)" > "$L/summary.txt"
step qa-gate "./scripts/qa-gate.sh --veloce"
step shards "bun run test:unit:shards"
step bundle "bun run build:client && bun run check:bundle"
step e2e "SERVER_HOST=127.0.0.1 E2E_TIER=pr npx playwright test --project=chromium tests/e2e/board-*.spec.ts tests/e2e/chat-*.spec.ts --reporter=list"
echo DONE >> "$L/summary.txt"
