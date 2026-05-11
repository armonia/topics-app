#!/bin/bash
# Start prod server with auto-reload for both server and client
cd /Users/user/Projects/topics-app

# ─── Single-instance guard (2026-05-11) ────────────────────────────────────
# Without this, every `launchctl bootout`/`bootstrap` cycle (or any glitchy
# `KeepAlive=true` restart) leaves a SECOND `start-prod.sh` running in
# parallel. Each instance spawns its own fswatch + bun --watch, so every
# real change fires N builds — AND fswatch can emit phantom events at a
# steady cadence (~10 s in our case), which manifested as "the app
# refreshes by itself every 10 seconds". Holding a PID lockfile keeps
# exactly one instance alive.
LOCKFILE="/tmp/topics-start-prod.lock"
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "$$" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[start-prod] Another instance is already running (PID $OLD_PID). Exiting."
    exit 0
  fi
  # Stale lockfile — clean up
  rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"

# Atomic-write check: only proceed if we won the race
sleep 0.2
WINNER=$(cat "$LOCKFILE" 2>/dev/null)
if [ "$WINNER" != "$$" ]; then
  echo "[start-prod] Lost race to PID $WINNER. Exiting."
  exit 0
fi

# Clean up the lockfile + any child processes on exit so a future restart
# isn't blocked by a stale PID. SIGTERM from launchd lands here.
cleanup() {
  rm -f "$LOCKFILE"
  # Kill the background fswatch loop subshell + bun --watch
  jobs -p | xargs -r kill 2>/dev/null
}
trap cleanup EXIT INT TERM

# Initial client build
(cd client && npx vite build 2>&1 | tail -3)

# ─── Coalesced fswatch → vite build ───────────────────────────────────────
# Why this is non-trivial: a single `git pull`/`git merge` can touch 30+
# files in client/src/ at near-identical timestamps. Without coalescing,
# fswatch emits 30+ events and we run 30+ sequential `npx vite build`
# calls (each ~5-25 s). During that window the Electron auto-reloader
# fires every time `public/index.html` changes — for ~3 minutes — and
# the renderer can ack a bare default `pane-store-v2` snapshot to the
# server, clobbering the user's open chat tabs (Phase A → H post-mortem).
#
# Strategy:
#   1. fswatch emits raw change events (one per file).
#   2. Bash reader gathers events into a 2-second silence window
#      (`read -t 2` — when the timeout fires, no new event has arrived
#      for 2 s, so it's safe to flush a single rebuild).
#   3. Skip rebuilds while a git operation is in flight (presence of
#      .git/MERGE_HEAD, .git/REBASE_HEAD, .git/CHERRY_PICK_HEAD, etc.).
#      Those events are coalesced into ONE rebuild after the operation
#      completes.
#
# Net: 30 simultaneous file changes → 1 vite build → 1 Electron reload.

is_git_op_in_progress() {
  for f in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD BISECT_LOG REVERT_HEAD; do
    if [ -e ".git/$f" ]; then
      return 0
    fi
  done
  return 1
}

(
  while true; do
    fswatch -r -e ".*" -i "\\.tsx$" -i "\\.ts$" -i "\\.css$" client/src/ |
    while true; do
      # Block until the first event.
      if ! IFS= read -r first_event; then
        break  # fswatch closed
      fi
      pending="$first_event"
      collected=1

      # Drain everything that arrives within the silence window. Each
      # arrival resets the timer. When the timer fires (no new event
      # in 2 s) we flush a single rebuild covering the whole batch.
      while IFS= read -r -t 2 next_event; do
        pending="$next_event"
        collected=$((collected + 1))
      done

      if is_git_op_in_progress; then
        echo "[$(date +%H:%M:%S)] git operation in progress (.git/MERGE_HEAD or sibling exists) — deferring rebuild (${collected} events queued)"
        # Wait until the git op completes, then fall through to rebuild.
        while is_git_op_in_progress; do sleep 1; done
        echo "[$(date +%H:%M:%S)] git operation finished — rebuilding now"
      else
        echo "[$(date +%H:%M:%S)] coalesced ${collected} change event(s) — rebuilding (last: $pending)"
      fi
      (cd client && npx vite build 2>&1 | tail -1)
    done
    echo "[$(date +%H:%M:%S)] fswatch exited, restarting in 2s..."
    sleep 2
  done
) &>/tmp/topics-client-watch.log &

# Start server with watch mode (ignore client/public to avoid restart on client rebuild)
# Use wait-based approach so the shell stays alive and can clean up children on exit
/Users/user/.bun/bin/bun --watch --watch-ignore='public/**' --watch-ignore='client/**' --watch-ignore='uploads/**' run /Users/user/Projects/topics-app/server.ts
