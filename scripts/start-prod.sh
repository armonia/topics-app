#!/bin/bash
# Start prod server with auto-reload for both server and client
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# ─── PATH hardening (2026-06-07) ───────────────────────────────────────────
# launchd hands this job a minimal PATH that does NOT include ~/.bun/bin, so the
# `bun --watch` invocation below failed with "bun: command not found" the moment
# the job was restarted — the server never came back up, and (because the PTY
# bridge is a child of the server) its parent-death watchdog then took the live
# Claude PTYs down with it. The old long-lived process only survived because it
# had been started under an interactive shell PATH that the plist no longer
# reproduces. Resolve bun (+ Homebrew/local) explicitly so a restart is always
# self-sufficient, regardless of the launchd environment.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

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
# isn't blocked by a stale PID. SIGTERM from launchd (`bootout`) lands here.
SERVER_PIDFILE="/tmp/topics-server.pid"
# Set by cleanup so the restart-on-exit loop below STOPS relaunching on a real
# shutdown. Without this the loop would resurrect the server after teardown,
# making the script unkillable by SIGTERM (only SIGKILL would stop it — which
# bypasses server.ts gracefulShutdown and orphans the PTY bridge + claude
# children, the exact failure this script set out to avoid).
SHUTTING_DOWN=0
cleanup() {
  # Drop the traps FIRST so the `exit` below doesn't re-enter cleanup through
  # the EXIT trap, and flag the loop to stop.
  trap - EXIT INT TERM
  SHUTTING_DOWN=1
  rm -f "$LOCKFILE" "$SERVER_PIDFILE"
  # SIGTERM the server child so server.ts gracefulShutdown runs (clean bridge
  # disconnect) rather than the child being orphaned.
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null
  # Kill our background watchers. NOTE: killing a watcher subshell does NOT reap
  # its `fswatch` grandchild, so we also pkill those by pattern.
  jobs -p | xargs -r kill 2>/dev/null
  pkill -P $$ 2>/dev/null
  pkill -f 'fswatch.*client/src' 2>/dev/null
  pkill -f 'fswatch.*[ /]server/' 2>/dev/null
  exit 0
}
trap cleanup EXIT INT TERM

# Reap watcher stragglers orphaned by a previously SIGKILL'd instance. `launchctl
# kickstart -k` SIGKILLs this script, bypassing the EXIT trap above, so each
# restart leaked the background fswatch LOOP SUBSHELLS (reparented to launchd,
# PPID 1) — and those respawn fswatch every 2 s forever, so 29 fswatch had piled
# up during the 2026-06-07 incident. Killing fswatch alone is not enough; we must
# kill the orphaned loop subshells too. The single-instance lock above means any
# other start-prod.sh process (PPID 1, not us) is a straggler.
for _p in $(pgrep -f 'topics-app/scripts/start-prod.sh' 2>/dev/null); do
  [ "$_p" = "$$" ] && continue
  [ "$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d ' ')" = "1" ] && kill -9 "$_p" 2>/dev/null
done
pkill -f 'fswatch.*client/src' 2>/dev/null
pkill -f 'fswatch.*[ /]server/' 2>/dev/null

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

# ─── Server: stable run + GRACEFUL reload on server/** change ──────────────
# We deliberately do NOT use `bun --watch`. In this app its watcher never fires
# (chased to an in-process interaction in the server runtime — every isolated
# repro reloads, the real server doesn't) AND, worse, bun --watch restarts via
# SIGKILL, which BYPASSES server.ts's gracefulShutdown — orphaning the PTY
# bridge + `claude` children on every reload (the 2026-06-07 incident). Instead
# we watch server/** ourselves and trigger a GRACEFUL reload: SIGTERM the server
# → gracefulShutdown runs (disconnects the bridge cleanly, flushes claude
# children) → the loop below relaunches it → reconcile reattaches the surviving
# PTYs (the bridge process lives on via its parent-death grace window).

graceful_reload() {
  local pid; pid=$(cat "$SERVER_PIDFILE" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return
  echo "[$(date +%H:%M:%S)] server/** changed → graceful reload (SIGTERM $pid)"
  kill -TERM "$pid" 2>/dev/null
  # Escalate to SIGKILL only if gracefulShutdown stalls past 8s.
  ( sleep 8; kill -0 "$pid" 2>/dev/null && { echo "[start-prod] graceful reload timed out → SIGKILL $pid"; kill -KILL "$pid" 2>/dev/null; } ) &
}

# Coalesced server-source watcher (mirrors the client one: a 2 s silence window
# batches a burst of saves into ONE reload, and defers across git operations).
(
  while true; do
    fswatch -r -e ".*" -i "\\.ts$" server/ |
    while true; do
      IFS= read -r _ev || break
      while IFS= read -r -t 2 _drain; do :; done   # coalesce the burst
      if is_git_op_in_progress; then
        while is_git_op_in_progress; do sleep 1; done
      fi
      graceful_reload
    done
    echo "[$(date +%H:%M:%S)] server fswatch exited, restarting in 2s..."
    sleep 2
  done
) &>/tmp/topics-server-watch.log &

# Restart-on-exit loop. A graceful reload (or a crash) drops us out of `wait`
# and we relaunch; launchd KeepAlive=true is the outer backstop if start-prod.sh
# itself ever dies. The server runs as a child (not exec) so this loop, the
# watcher, and the cleanup trap all stay alive across reloads.
#
# A SIGTERM to THIS script (launchd `bootout`, or the parent start-electron-prod
# cleanup) interrupts `wait`, runs cleanup → SHUTTING_DOWN=1 → exit, so the loop
# never relaunches on a real shutdown. We only loop again on a graceful reload
# (SIGTERM to the server CHILD via graceful_reload) or a crash.
while [ "$SHUTTING_DOWN" != 1 ]; do
  "$BUN" run "$APP_DIR/server.ts" &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$SERVER_PIDFILE"
  wait "$SERVER_PID"; code=$?
  # Re-check in case the SIGTERM raced in after `wait` returned but before the
  # trap set the flag — never relaunch once we're tearing down.
  [ "$SHUTTING_DOWN" = 1 ] && break
  echo "[$(date +%H:%M:%S)] server exited (code $code) — relaunching in 1s"
  sleep 1
done
