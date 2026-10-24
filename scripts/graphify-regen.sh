#!/usr/bin/env bash
#
# graphify-regen.sh — keep the code graph (graphify-out/graph.json) fresh.
#
# Invoked by the post-commit / post-merge git hooks. It is:
#   - ASYNC: forks a detached worker and returns immediately, so a commit or
#     merge NEVER waits on the rebuild.
#   - DEBOUNCED: a burst of commits collapses into a single rebuild (only the
#     last invocation inside the debounce window actually runs graphify).
#   - PATIENT: while the Mac is busy (load per core, memory pressure) or the
#     last rebuild is younger than GRAPHIFY_REGEN_MIN_INTERVAL, the worker waits
#     and re-checks, logging one "rimandato" line per pass. A newer commit
#     supersedes it. After GRAPHIFY_REGEN_MAX_WAIT seconds it runs anyway
#     ("forzato"). A rebuild is lost only when graphify fails (it is not retried
#     until the next commit) or when its worker is killed while it waits.
#   - SERIAL: one rebuild at a time. The lock is the directory graphify-out/.regen.lock
#     with the owner's pid in it. A live owner is never displaced, however old
#     the lock is; a dead owner's lock is reaped at once. A lock with no pid file
#     belongs to the previous version of this script (many worktrees still run it)
#     or to a worker between mkdir and its pid write: it is waited for, and
#     reaped only when older than STALE_LOCK_MINUTES, the previous script's own
#     rule for a crashed run.
#   - FREE: `graphify update` is a pure-AST re-extraction, no LLM calls.
#   - SILENT NO-OP when graphify is not installed or no graph exists yet.
#
# Nothing here ever exits non-zero into the hook: a broken graph must not be
# able to block a commit. Works on any bash, macOS /bin/bash 3.2 included: the
# worker learns its own pid without BASHPID (see below), which 3.2 lacks.

set -u

DEBOUNCE_SECONDS="${GRAPHIFY_REGEN_DEBOUNCE:-30}"
MIN_INTERVAL_SECONDS="${GRAPHIFY_REGEN_MIN_INTERVAL:-1200}"
MAX_LOAD_PER_CORE="${GRAPHIFY_REGEN_MAX_LOAD:-4}"
MAX_WAIT_SECONDS="${GRAPHIFY_REGEN_MAX_WAIT:-7200}"
BUSY_SLEEP_SECONDS="${GRAPHIFY_REGEN_BUSY_SLEEP:-300}"
# The previous script reaped a lock older than this; so do we, for a lock with no pid.
STALE_LOCK_MINUTES=30
# A zero sleep would spin the wait loop and flood the log: one second is the floor.
[ "$BUSY_SLEEP_SECONDS" -ge 1 ] 2>/dev/null || BUSY_SLEEP_SECONDS=1

# Sets REASON and returns 0 when the Mac is too busy for a rebuild; returns 1
# when it is quiet. The readings are sysctl's own output: vm.loadavg is
# "{ 1min 5min 15min }", kern.memorystatus_vm_pressure_level is 1 normal,
# 2 warn, 4 critical. Swap is not read: macOS allocates it on demand, so its
# used/total stays high while memory is fine. LC_ALL=C keeps the decimal dot:
# under an Italian locale awk prints "5,00", and the reason text would change.
mac_busy() {
  local ncpu load1 per_core level
  ncpu="$(sysctl -n hw.ncpu 2>/dev/null)" || ncpu=1
  load1="$(sysctl -n vm.loadavg 2>/dev/null | LC_ALL=C awk '{print $2}')"
  per_core="$(LC_ALL=C awk -v l="${load1:-0}" -v c="${ncpu:-1}" 'BEGIN { printf "%.2f", l / c }')"
  if LC_ALL=C awk -v p="$per_core" -v m="$MAX_LOAD_PER_CORE" 'BEGIN { exit !(p + 0 > m + 0) }'; then
    REASON="load ${per_core}/core sopra ${MAX_LOAD_PER_CORE}"
    return 0
  fi
  level="$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
  case "$level" in ''|*[!0-9]*) level=1 ;; esac
  if [ "$level" -ge 4 ]; then
    REASON="pressione di memoria critica (${level})"
    return 0
  fi
  return 1
}

# Sets REASON and WAIT_SECONDS and returns 0 when this rebuild must wait; 1
# when it may run now.
must_wait() {
  local last age
  last="$(cat "$out/.regen.last" 2>/dev/null)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  age=$(( $(date +%s) - last ))
  if [ "$age" -lt "$MIN_INTERVAL_SECONDS" ]; then
    REASON="ultimo rebuild ${age}s fa (minimo ${MIN_INTERVAL_SECONDS}s)"
    WAIT_SECONDS=$(( MIN_INTERVAL_SECONDS - age ))
    return 0
  fi
  if mac_busy; then
    WAIT_SECONDS=$BUSY_SLEEP_SECONDS
    return 0
  fi
  return 1
}

# Removes the lock when its owner is dead. Returns 0 when the lock is gone, 1
# when someone may still hold it. A lock with no pid file is held by the previous
# version of this script, or by a worker between mkdir and its pid write: it is
# left alone until it is older than STALE_LOCK_MINUTES, when the previous script
# would reap it too.
reap_dead_lock() {
  local owner
  [ -d "$lock" ] || return 0
  owner="$(cat "$lock/pid" 2>/dev/null)"
  if [ -z "$owner" ]; then
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +"$STALE_LOCK_MINUTES" 2>/dev/null)" ]; then
      rmdir "$lock" 2>/dev/null || true
      return 0
    fi
    return 1
  fi
  if kill -0 "$owner" 2>/dev/null; then
    return 1
  fi
  if [ "$(cat "$lock/pid" 2>/dev/null)" = "$owner" ]; then
    rm -f "$lock/pid"
    rmdir "$lock" 2>/dev/null || true
  fi
  return 0
}

# Drops the lock only while it still names this worker: another worker may
# have reaped ours and taken the lock since.
release_lock() {
  [ "$(cat "$lock/pid" 2>/dev/null)" = "$me" ] || return 0
  rm -f "$lock/pid"
  rmdir "$lock" 2>/dev/null || true
}

# graphify absent → silent no-op (task requirement).
command -v graphify >/dev/null 2>&1 || exit 0

# Resolve the MAIN working tree. Worktrees share hooks with the primary
# checkout; the graph lives with the primary checkout, so rebuild that one.
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
case "$common" in
  */.git) repo="$(dirname "$common")" ;;
  *)      repo="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0 ;;
esac
[ -n "$repo" ] && [ -d "$repo" ] || exit 0

out="$repo/graphify-out"
# No graph yet → nothing to keep fresh (don't build one from a hook).
[ -f "$out/graph.json" ] || exit 0

req="$out/.regen.request"
lock="$out/.regen.lock"
log="$out/regen.log"

# Unique token for this invocation; the last writer inside the window wins.
token="$(date +%s)-$$-${RANDOM:-0}"
echo "$token" >"$req" 2>/dev/null || exit 0

# Detach the worker so the git operation returns instantly.
(
  sleep "$DEBOUNCE_SECONDS"

  # The worker's own pid, which is the lock's owner. The hook's $$ is no good:
  # the hook exits right after forking, so its pid is dead to every other worker.
  # BASHPID does not exist in bash 3.2, and a plain $(sh -c 'echo $PPID') reports
  # the command substitution's own subshell, not the worker. exec makes that
  # subshell become sh, so sh's parent is the worker.
  me="$(exec sh -c 'echo $PPID')"
  # A lock that names nobody would let a second worker in: better no rebuild.
  case "$me" in ''|*[!0-9]*) exit 0 ;; esac
  trap release_lock EXIT

  token_ok() { [ "$(cat "$req" 2>/dev/null)" = "$token" ]; }

  # A wait is appended to the log as it happens (append never truncates), and
  # kept in memory too: the log is truncated only by the worker that wins the
  # lock, and it writes the waits back after the truncation.
  waited=0
  forced=0
  waitlog=""
  note() {
    waitlog="${waitlog}$1"$'\n'
    echo "$1" >>"$log"
  }
  while :; do
    # Superseded by a newer commit → that worker carries the rebuild now.
    token_ok || exit 0
    if [ "$forced" -eq 0 ] && must_wait; then
      stamp="$(date '+%Y-%m-%d %H:%M:%S')"
      if [ "$waited" -ge "$MAX_WAIT_SECONDS" ]; then
        forced=1
        note "$stamp forzato ($REASON)"
      else
        note "$stamp rimandato: $REASON"
        step="$WAIT_SECONDS"
        left=$(( MAX_WAIT_SECONDS - waited ))
        [ "$left" -lt "$step" ] && step="$left"
        sleep "$step"
        waited=$(( waited + step ))
        continue
      fi
    fi

    # A live run holding the lock makes us wait for it, not give up: our commit
    # came after its start, so it does not index that commit.
    if mkdir "$lock" 2>/dev/null; then
      echo "$me" >"$lock/pid"
      token_ok || exit 0
      # The Mac may have gone busy, or the last rebuild may be too recent, while
      # we waited for the lock: release it and wait again.
      if [ "$forced" -eq 0 ] && must_wait; then
        release_lock
        continue
      fi
      break
    fi
    reap_dead_lock && continue
    sleep 5
  done

  : >"$log"
  printf '%s' "$waitlog" >>"$log"

  {
    echo "=== graphify update @ $(date '+%Y-%m-%d %H:%M:%S') (${repo}) ==="
    # At agent priority (KANBAN-78): the hook fires after EVERY commit of EVERY
    # agent worktree, and a full AST re-extraction at normal priority was one of
    # the loads that made the desktop crawl on 2026-09-06 (four of them at once,
    # 30 % CPU each). nice everywhere, plus the macOS background QoS (-b) where
    # it exists.
    lowprio="nice -n 15"
    command -v taskpolicy >/dev/null 2>&1 && lowprio="taskpolicy -b $lowprio"
    $lowprio graphify update "$repo"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      # Stamp only a successful run: a failed one must not hold off the next.
      date +%s >"$out/.regen.last"
    else
      echo "graphify uscito con codice ${rc}: nessun rebuild registrato, niente retry fino al prossimo commit"
    fi

    # Retention. A full `/graphify` run drops a dated YYYY-MM-DD/ snapshot next
    # to the live outputs, ~20 MB each. Nothing reads them — the server resolves
    # "$out/graph.json" (server/context/assemble.ts) — so left alone they grew to
    # 361 MB / 17 copies. Keep the newest few for rollback, drop the rest.
    keep="${GRAPHIFY_KEEP_SNAPSHOTS:-3}"
    snaps="$(ls -1d "$out"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] 2>/dev/null | sort)"
    total="$(printf '%s\n' "$snaps" | grep -c . || true)"
    if [ "${total:-0}" -gt "$keep" ]; then
      printf '%s\n' "$snaps" | sed -n "1,$((total - keep))p" | while IFS= read -r snap; do
        [ -n "$snap" ] && rm -rf "$snap" && echo "retention: rimosso $(basename "$snap")"
      done
    fi
  } >>"$log" 2>&1 || true
) </dev/null >/dev/null 2>&1 &

exit 0
