#!/usr/bin/env bash
# Reproduce the whole matrix. Requires: node >=21, Playwright browsers (chromium-1223 +
# chromium_headless_shell-1223) in ~/Library/Caches/ms-playwright. No network beyond page loads.
set -u
cd "$(dirname "$0")"

echo "### 1. Raw --remote-debugging-port CDP (lightweight build only) ###"
echo "# footprint (startup-to-CDP-ready + RSS tree):"
node footprint.mjs headless-shell 9333
echo "# screencast vs captureScreenshot:"
node screencast.mjs headless-shell 9344 5000
echo "# input latency:"
node input.mjs headless-shell 9355 30

echo
echo "### 2. Unified Playwright-driven CDP matrix (all engines) ###"
: > results.jsonl
for eng in headless-shell chromium-headless chromium-headful; do
  for trial in 1 2; do
    echo ">>> $eng trial $trial" >&2
    node pw-bench.mjs "$eng" 5000 | tee -a results.jsonl
  done
done
echo "# aggregated JSON in results.jsonl"
