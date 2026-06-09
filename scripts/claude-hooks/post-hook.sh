#!/usr/bin/env sh
# Topics App — Claude Code hook wrapper.
#
# Claude Code invokes this script with the hook payload on stdin and the event
# name as $1. We POST the payload (augmented server-side with hook_event_name)
# to Topics App's local hook endpoint. The exit code is ALWAYS 0 — a failing
# POST must NEVER block Claude's interactive loop.
#
# Token: read from ~/.claude/topics-hook-token (mode 0600). Created by the
# Topics App server on first boot.
#
# Transport: the server (server.ts → Bun.serve) listens HTTPS-ONLY on :3333
# with a self-signed cert — there is NO plain-HTTP listener on that port. So we
# POST over HTTPS with `curl -k` (accept the self-signed cert; localhost + the
# bearer token are the real defense). Posting plain HTTP to the TLS port was a
# long-standing SILENT bug: every hook failed with curl exit 52, the `|| true`
# swallowed it, and so session phases never advanced past `starting` — no
# completion notifications, and the noisy pty-idle heuristic became the only
# (false-positive-prone) signal. Override the base with $TOPICS_APP_URL; if it
# points at a non-TLS server, the https attempt fails and we fall back to http.

set -e

EVENT_NAME="${1:-Unknown}"
URL_BASE="${TOPICS_APP_URL:-https://127.0.0.1:3333}"
TOKEN_FILE="${HOME}/.claude/topics-hook-token"

[ -r "$TOKEN_FILE" ] || exit 0   # silently no-op if not installed

TOKEN="$(cat "$TOKEN_FILE")"
PAYLOAD="$(cat)"

# Single POST attempt against a given base. `-k`/--insecure accepts the
# self-signed localhost cert; harmless against a plain-HTTP base. 2s hard
# timeout, no retry, body discarded — we don't care about the response.
post() {
  curl --silent --show-error --insecure --output /dev/null \
    --max-time 2 \
    --retry 0 \
    --request POST \
    --header "Authorization: Bearer ${TOKEN}" \
    --header "Content-Type: application/json" \
    --data "${PAYLOAD}" \
    "$1/api/claude-hooks/${EVENT_NAME}" \
    >/dev/null 2>&1
}

# Primary attempt (HTTPS by default). If it fails, retry with the other scheme
# so the hook works whether the server is TLS or plain-HTTP. Worst case is two
# 2s timeouts (4s), under Claude's 5s hook budget; the happy path is <50ms.
if ! post "${URL_BASE}"; then
  case "${URL_BASE}" in
    https://*) post "http://${URL_BASE#https://}" || true ;;
    http://*)  post "https://${URL_BASE#http://}" || true ;;
  esac
fi

exit 0
