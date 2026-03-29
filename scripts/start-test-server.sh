#!/usr/bin/env bash
# start-test-server.sh — Start an isolated test server on port 3334.
# Used by Playwright globalSetup to run E2E tests against a dedicated instance
# with its own SQLite database at /tmp/topics-test-data/topics.db.
#
# The server reads BUN_PORT and DATA_DIR from environment (see server/utils.ts).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export BUN_PORT=3334
export DATA_DIR=/tmp/topics-test-data
export GATEWAY_TOKEN="${GATEWAY_TOKEN:-test-token}"
export GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"

# Ensure data directory exists
mkdir -p "$DATA_DIR"

cd "$REPO_ROOT"
exec bun run server.ts
