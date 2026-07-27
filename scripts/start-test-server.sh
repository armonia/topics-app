#!/usr/bin/env bash
# start-test-server.sh — Avvia un server di test isolato.
#
# Lo usa il globalSetup di Playwright per far girare gli E2E contro un'istanza
# dedicata, con il suo SQLite sotto $DATA_DIR/topics.db.
#
# Porta e percorsi arrivano dall'AMBIENTE, con i default storici come fallback
# (13334 + /tmp/topics-test-data): è ciò che permette a più shard di girare
# insieme sulla stessa macchina, ognuno col suo server, il suo DB e i suoi
# socket. Chi chiama compone quell'ambiente in UN posto solo —
# `testServerEnv()` in tests/e2e/helpers/test-server.ts — e questo script si
# limita a colmare i buchi (`:-`), così un valore esplicito vince sempre.
#
# Il server legge BUN_PORT e DATA_DIR da environment (vedi server/utils.ts).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export BUN_PORT="${BUN_PORT:-13334}"
if [ "$BUN_PORT" = "13334" ]; then
  DEFAULT_DATA_DIR=/tmp/topics-test-data
else
  DEFAULT_DATA_DIR="/tmp/topics-test-data-${BUN_PORT}"
fi
export DATA_DIR="${DATA_DIR:-$DEFAULT_DATA_DIR}"
# Phase 30 plan 30-05: dedicated TOPICS_HOME so the test server doesn't
# compete with the dev server (which holds ~/.topics/daemon-process.lock).
export TOPICS_HOME="${TOPICS_HOME:-$DATA_DIR/.topics-home}"
# Isolate OpenClaw config/session reads from the real user (server/utils.ts
# falls back to `${HOME}/.openclaw` when OPENCLAW_DIR is unset — SESSIONS_DIR
# derives from OPENCLAW_DIR the same way, so overriding this one var covers
# both). HOME itself is also overridden below for any other `~`-relative
# reads (e.g. utils.ts's ALLOWED_FILE_BASES, media dirs) — this is safe for
# PTY-spawned `claude`/`codex` terminal sessions specifically, since
# server/routes/terminal.ts pins THEIR env to `realHome()` (the real OS
# account home via getpwuid), not `process.env.HOME`, precisely so a sandboxed
# HOME here never leaks into those spawns (see server/utils/path-env.ts).
export OPENCLAW_DIR="${OPENCLAW_DIR:-$DATA_DIR/.openclaw}"
export HOME="$DATA_DIR/.home"
# Dedicated PTY-bridge socket so EVERY server started via this script — the
# initial globalSetup server AND any in-test restart (terminal-session-resume)
# — is bridge-isolated. Without this, a restart that omits TOPICS_PTY_SOCKET
# falls back to the cwd-derived socket = the PRODUCTION bridge, whose live
# Claude PTYs the test reconcile then kills (knocking dev sessions dormant).
# Defaulted (`:-`) so an explicit value from globalSetup still wins.
export TOPICS_PTY_SOCKET="${TOPICS_PTY_SOCKET:-/tmp/topics-pty-bridge-e2e-${BUN_PORT}.sock}"
# Same isolation for the ai-bridge (stream-json broker) socket, for the same
# reason: a test server (or an in-test restart) must NEVER derive the cwd-based
# socket = the PRODUCTION ai-bridge. Harmless when TOPICS_AI_BRIDGE is unset
# (nothing connects); required the moment a broker restart-survival test enables
# the flag. Enable the feature for such a test with TOPICS_AI_BRIDGE=1.
export TOPICS_AI_BRIDGE_SOCKET="${TOPICS_AI_BRIDGE_SOCKET:-/tmp/topics-ai-bridge-e2e-${BUN_PORT}.sock}"
export GATEWAY_TOKEN="${GATEWAY_TOKEN:-test-token}"
export GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"

# Ensure data + topics-home + isolated OpenClaw config/home directories exist
mkdir -p "$DATA_DIR" "$TOPICS_HOME" "$OPENCLAW_DIR" "$HOME"

cd "$REPO_ROOT"
exec bun run server.ts
