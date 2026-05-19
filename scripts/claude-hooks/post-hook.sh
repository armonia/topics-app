#!/usr/bin/env sh
# Topics App — Claude Code hook wrapper.
#
# Claude Code invokes this script with the hook payload on stdin and the
# event name as $1. We POST the payload (augmented with hook_event_name) to
# Topics App's local hook endpoint. The exit code is always 0 — a failing
# POST must NEVER block Claude's interactive loop.
#
# Token: read from ~/.claude/topics-hook-token (mode 0600). Created by the
# Topics App server on first boot.
#
# Server URL: defaults to http://127.0.0.1:3333; override with
# $TOPICS_APP_URL. We talk HTTP, not HTTPS, on localhost — the dev server
# offers both and we prefer the unauthenticated TLS-less path to avoid a
# system curl tripping over the self-signed cert. The token is the only
# defense; the endpoint already rejects non-localhost requests.

set -e

EVENT_NAME="${1:-Unknown}"
URL_BASE="${TOPICS_APP_URL:-http://127.0.0.1:3333}"
TOKEN_FILE="${HOME}/.claude/topics-hook-token"

if [ ! -r "$TOKEN_FILE" ]; then
  exit 0  # silently no-op if not installed
fi

TOKEN="$(cat "$TOKEN_FILE")"
PAYLOAD="$(cat)"

# 2-second hard timeout, no progress bar, single retry on transient errors.
# Discard body — we don't care about the response.
curl --silent --show-error --output /dev/null \
  --max-time 2 \
  --retry 0 \
  --request POST \
  --header "Authorization: Bearer ${TOKEN}" \
  --header "Content-Type: application/json" \
  --data "${PAYLOAD}" \
  "${URL_BASE}/api/claude-hooks/${EVENT_NAME}" \
  >/dev/null 2>&1 || true

exit 0
