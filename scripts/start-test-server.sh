#!/usr/bin/env bash
# start-test-server.sh — Start an isolated test server on port 13334.
# Used by Playwright globalSetup to run E2E tests against a dedicated instance
# with its own SQLite database at /tmp/topics-test-data/topics.db.
#
# The server reads BUN_PORT and DATA_DIR from environment (see server/utils.ts).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export BUN_PORT=13334
export DATA_DIR=/tmp/topics-test-data
# Phase 30 plan 30-05: dedicated TOPICS_HOME so the test server doesn't
# compete with the dev server (which holds ~/.topics/daemon-process.lock).
export TOPICS_HOME="${TOPICS_HOME:-/tmp/topics-test-data/.topics-home}"
# Dedicated PTY-bridge socket so EVERY server started via this script — the
# initial globalSetup server AND any in-test restart (terminal-session-resume)
# — is bridge-isolated. Without this, a restart that omits TOPICS_PTY_SOCKET
# falls back to the cwd-derived socket = the PRODUCTION bridge, whose live
# Claude PTYs the test reconcile then kills (knocking dev sessions dormant).
# Defaulted (`:-`) so an explicit value from globalSetup still wins.
export TOPICS_PTY_SOCKET="${TOPICS_PTY_SOCKET:-/tmp/topics-pty-bridge-e2e-test.sock}"
export GATEWAY_TOKEN="${GATEWAY_TOKEN:-test-token}"
export GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"

# Ensure data + topics-home directories exist
mkdir -p "$DATA_DIR" "$TOPICS_HOME"

cd "$REPO_ROOT"
exec bun run server.ts
