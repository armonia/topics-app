#!/usr/bin/env bash
# T9 bar: run from the repo root. Usage: barra.sh <label>. Logs into $SCR/barra-<label>/.
set -u
# e2e only: SERVER_HOST=127.0.0.1, the VM has no IPv6 (without it the test server dies with EAFNOSUPPORT, as in T5)
SCR=/tmp/claude-0/-home-user-topics-app/ca1dc473-2ea1-5d3e-ad2f-9fe43dcf3303/scratchpad
OUT=$SCR/barra-$1; mkdir -p "$OUT"
export PATH=/opt/node20/bin:$PATH
export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright
cd /home/user/topics-app
SPECS="tests/e2e/processes-run-command.spec.ts tests/e2e/project-scripts.spec.ts tests/e2e/chat-running-server.spec.ts tests/e2e/chat-command-visible.spec.ts tests/e2e/system.spec.ts tests/e2e/file-explorer-git.spec.ts tests/e2e/browser-process.spec.ts"
{ echo "HEAD $(git rev-parse --short HEAD)"; uptime; } > "$OUT/summary.txt"
./scripts/qa-gate.sh --veloce > "$OUT/qa-gate.log" 2>&1; echo "qa-gate exit=$?" >> "$OUT/summary.txt"
bun run test:unit:shards > "$OUT/unit.log" 2>&1; echo "unit exit=$?" >> "$OUT/summary.txt"
(bun run build:client && bun run check:bundle) > "$OUT/bundle.log" 2>&1; echo "bundle exit=$?" >> "$OUT/summary.txt"
SERVER_HOST=127.0.0.1 E2E_TIER=pr npx playwright test --project=chromium $SPECS > "$OUT/e2e.log" 2>&1; echo "e2e exit=$?" >> "$OUT/summary.txt"
uptime >> "$OUT/summary.txt"
