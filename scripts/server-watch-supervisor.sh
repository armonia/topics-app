#!/bin/bash
# Keep the opt-in production watcher alive without coupling its lifetime to the
# server. This process is itself a child of start-prod.sh, so stopping the main
# supervisor still tears the whole tree down.
#
# An already-running start-prod.sh can adopt this fix without restarting its
# server: launch this script with the application root and existing server PID
# file. The atomic process lock makes that bootstrap idempotent:
# TOPICS_SERVER_WATCH=1 nohup scripts/server-watch-supervisor.sh "$PWD" \
#   /tmp/topics-server.pid >> /tmp/topics-server-watch-supervisor.log 2>&1 &
set -uo pipefail

APP_DIR="${1:?usage: server-watch-supervisor.sh <APP_DIR> [<server pidfile>]}"
SERVER_PIDFILE="${2:-/tmp/topics-server.pid}"
MANAGED_PARENT_PID="${3:-}"
WATCH_SCRIPT="${TOPICS_SERVER_WATCH_SCRIPT:-$APP_DIR/scripts/server-watch.sh}"
SUPERVISOR_PIDFILE="${TOPICS_SERVER_WATCH_SUPERVISOR_PIDFILE:-/tmp/topics-server-watch-supervisor.pid}"
STABLE_S="${TOPICS_SERVER_WATCH_STABLE_S:-10}"
BACKOFF_DELAY="${TOPICS_SERVER_WATCH_BACKOFF_DELAY:-2}"
BACKOFF_MAX="${TOPICS_SERVER_WATCH_BACKOFF_MAX:-30}"
FSWATCH_STOP_GRACE_S="${TOPICS_FSWATCH_STOP_GRACE_S:-3}"
# The outer grace must leave the watcher enough time to stop and reap fswatch.
STOP_GRACE_S="${TOPICS_SERVER_WATCHER_STOP_GRACE_S:-$((FSWATCH_STOP_GRACE_S + 2))}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/server-watch-lock.sh"

WATCHER_PID=""
SHUTTING_DOWN=0

cleanup() {
  trap - EXIT INT TERM
  SHUTTING_DOWN=1
  stop_parent_watchdog
  if [ -n "$WATCHER_PID" ] && kill -0 "$WATCHER_PID" 2>/dev/null; then
    kill -TERM "$WATCHER_PID" 2>/dev/null
    ( exec 9>&-; sleep "$STOP_GRACE_S"; kill -KILL "$WATCHER_PID" 2>/dev/null ) &
    STOP_GUARD_PID=$!
    wait "$WATCHER_PID" 2>/dev/null
    kill -TERM "$STOP_GUARD_PID" 2>/dev/null
    wait "$STOP_GUARD_PID" 2>/dev/null
  fi
  release_process_lock "$SUPERVISOR_PIDFILE"
  exit 0
}

if [ "${TOPICS_SERVER_WATCH:-0}" != 1 ]; then
  exit 0
fi

acquire_process_lock "$SUPERVISOR_PIDFILE" "server-watch-supervisor.sh" || exit 0
trap cleanup EXIT INT TERM
start_parent_watchdog "$MANAGED_PARENT_PID" "$$" || exit 1

BACKOFF_CUR=0
while [ "$SHUTTING_DOWN" != 1 ]; do
  STARTED_AT=$(exec 9>&-; date +%s)
  /bin/bash "$WATCH_SCRIPT" "$APP_DIR" "$SERVER_PIDFILE" "$$" 9>&- &
  WATCHER_PID=$!
  wait "$WATCHER_PID"
  CODE=$?
  WATCHER_PID=""
  [ "$SHUTTING_DOWN" = 1 ] && break

  LIVED=$(( $(exec 9>&-; date +%s) - STARTED_AT ))
  if [ "$LIVED" -lt "$STABLE_S" ]; then
    if [ "$BACKOFF_CUR" -lt "$BACKOFF_DELAY" ]; then
      BACKOFF_CUR="$BACKOFF_DELAY"
    else
      BACKOFF_CUR=$(( BACKOFF_CUR * 2 ))
    fi
    [ "$BACKOFF_CUR" -gt "$BACKOFF_MAX" ] && BACKOFF_CUR="$BACKOFF_MAX"
    RESTART_DELAY="$BACKOFF_CUR"
  else
    BACKOFF_CUR=0
    RESTART_DELAY=1
  fi

  echo "[server-watch-supervisor] watcher pid exited after ${LIVED}s (code $CODE); restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY" 9>&-
done
