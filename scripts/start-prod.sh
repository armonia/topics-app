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

# ─── Optional LOCAL env overrides (per-machine, NOT committed) ──────────────
# A developer's own machine can enable experimental server flags (e.g.
# TOPICS_AI_BRIDGE=1 to run the detached AI broker) by dropping `export FOO=bar`
# lines in ~/.topics-server-env. The file never exists on a downloaded/other
# install, so released builds stay clean — this line is a harmless no-op there.
[ -f "$HOME/.topics-server-env" ] && source "$HOME/.topics-server-env"

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

# Client bundle: /public is a DEPLOY ARTIFACT, not a boot product (2026-07-13).
# The old unconditional `npx vite build` here rebuilt the client from the LIVE
# repo on every kickstart — which (a) kept the server DOWN for the whole build
# (minutes under launchd on a loaded box), and (b) shipped whatever WIP other
# sessions had in client/src, silently overwriting the clean-worktree build
# that the deploy flow rsyncs into /public (see CLAUDE.md: build SOLO da
# worktree pulito). Kickstart = server restart; the bundle only changes when a
# deploy deliberately replaces /public. Bootstrap-only fallback: build once if
# the bundle is missing entirely (fresh checkout).
if [ ! -f "$APP_DIR/public/index.html" ]; then
  echo "[start-prod] /public is empty — bootstrap client build"
  (cd client && npx vite build 2>&1 | tail -3)
fi

# ─── Client: STABLE bundle, no reload-on-source-change ─────────────────────
# The production app serves the /public bundle built once above. We deliberately
# do NOT watch client/src and auto-rebuild+reload. A vite build rewrites
# public/index.html, and Electron's asset-watcher then reloads EVERY window —
# blanking every pane (terminals repaint their xterm canvas, chats re-hydrate
# from the WS) on each rebuild. That is catastrophic whenever ANOTHER Claude
# session is editing client files: the running app flashes empty repeatedly
# (2026-06-22 incident — the symptom looked like empty/black panes).
#
# Live client hot-reload belongs in `bun run dev:client` (Vite HMR, see
# CLAUDE.md "Development"), NOT in this production launchd agent. To apply
# client source changes to the running app, rebuild + reload DELIBERATELY:
#   launchctl kickstart -k gui/$(id -u)/com.armonia.topics-server
# (re-runs the initial `npx vite build` above, then Electron reloads once).

# ─── Server: STABLE run, no reload-on-source-change ────────────────────────
# The production server hosts LIVE Claude PTY sessions and every client's
# WebSocket. It must NOT restart itself when source changes. The previous
# behaviour watched server/** with fswatch and SIGTERM'd the server on every
# `.ts` save — which dropped ALL WebSockets (blanking every open pane) and the
# in-app Claude session connections. That is catastrophic whenever ANOTHER
# Claude session is actively editing server files: the running app flaps
# between reloads and panes show empty (2026-06-22 incident).
#
# Live hot-reload of server code belongs in `bun run dev:server` (see CLAUDE.md
# "Development"), NOT in this production launchd agent. To apply server source
# changes to the running app, reload it DELIBERATELY:
#   launchctl kickstart -k gui/$(id -u)/com.armonia.topics-server
# (`bun --watch` is also rejected: it restarts via SIGKILL, bypassing
# server.ts gracefulShutdown and orphaning the PTY bridge + claude children.)

# Restart-on-CRASH loop. An UNEXPECTED server exit drops us out of `wait` and we
# relaunch after 1s; launchd KeepAlive=true is the outer backstop if
# start-prod.sh itself dies. A SIGTERM to THIS script (launchd `bootout`, or the
# parent cleanup) interrupts `wait`, runs cleanup → SHUTTING_DOWN=1 → exit, so
# the loop never relaunches on a real shutdown. There is no reload-on-edit: the
# server only comes back after a genuine crash.
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
