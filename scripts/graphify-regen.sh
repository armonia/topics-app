#!/usr/bin/env bash
#
# graphify-regen.sh — keep the code graph (graphify-out/graph.json) fresh.
#
# Invoked by the post-commit / post-merge git hooks. It is:
#   - ASYNC: forks a detached worker and returns immediately, so a commit or
#     merge NEVER waits on the rebuild.
#   - DEBOUNCED: a burst of commits collapses into a single rebuild (only the
#     last invocation inside the debounce window actually runs graphify).
#   - FREE: `graphify update` is a pure-AST re-extraction, no LLM calls.
#   - QUIET: skipped while the Mac is loaded (load per core, swap) or when the
#     last successful rebuild is younger than GRAPHIFY_REGEN_MIN_INTERVAL. The
#     request file stays, so the next commit retries.
#   - SILENT NO-OP when graphify is not installed or no graph exists yet.
#
# Nothing here ever exits non-zero into the hook: a broken graph must not be
# able to block a commit.

set -u

DEBOUNCE_SECONDS="${GRAPHIFY_REGEN_DEBOUNCE:-30}"
MIN_INTERVAL_SECONDS="${GRAPHIFY_REGEN_MIN_INTERVAL:-1200}"
MAX_LOAD_PER_CORE="${GRAPHIFY_REGEN_MAX_LOAD:-1.5}"
MAX_SWAP_PCT=85
STALE_LOCK_MINUTES=30

# Why the Mac is too busy for a rebuild, if it is: prints the reason and
# returns 0; returns 1 when it is quiet enough. The *_OVERRIDE variables exist
# only so the test can script the readings.
busy_reason() {
  local ncpu load1 per_core swap_pct
  ncpu="$(sysctl -n hw.ncpu 2>/dev/null)" || ncpu=1
  if [ -n "${GRAPHIFY_REGEN_LOAD_OVERRIDE:-}" ]; then
    per_core="$GRAPHIFY_REGEN_LOAD_OVERRIDE"
  else
    # vm.loadavg prints "{ 1min 5min 15min }": the 1-minute figure is field 2.
    load1="$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
    per_core="$(awk -v l="${load1:-0}" -v c="$ncpu" 'BEGIN { printf "%.2f", l / c }')"
  fi
  if awk -v p="$per_core" -v m="$MAX_LOAD_PER_CORE" 'BEGIN { exit !(p + 0 > m + 0) }'; then
    echo "load ${per_core}/core sopra ${MAX_LOAD_PER_CORE}"
    return 0
  fi
  if [ -n "${GRAPHIFY_REGEN_SWAP_PCT_OVERRIDE:-}" ]; then
    swap_pct="$GRAPHIFY_REGEN_SWAP_PCT_OVERRIDE"
  else
    # vm.swapusage: "total = 14336.00M  used = 12737.81M ..." (units M or G).
    swap_pct="$(sysctl -n vm.swapusage 2>/dev/null | awk '
      function mb(s) { v = substr(s, 1, length(s) - 1) + 0; return substr(s, length(s)) == "G" ? v * 1024 : v }
      { t = mb($3); u = mb($6); if (t > 0) printf "%d", u * 100 / t; else print 0 }')"
  fi
  if [ "${swap_pct:-0}" -gt "$MAX_SWAP_PCT" ] 2>/dev/null; then
    echo "swap ${swap_pct}% sopra ${MAX_SWAP_PCT}%"
    return 0
  fi
  return 1
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

  # Superseded by a newer commit inside the window → let that one rebuild.
  [ "$(cat "$req" 2>/dev/null)" = "$token" ] || exit 0

  # Too busy: leave the request in place, so the next commit retries.
  if reason="$(busy_reason)"; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') saltato: Mac carico ($reason)" >>"$log"
    exit 0
  fi

  # Minimum interval between successful rebuilds (stamped in .regen.last).
  last="$(cat "$out/.regen.last" 2>/dev/null)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  age=$(( $(date +%s) - last ))
  if [ "$age" -lt "$MIN_INTERVAL_SECONDS" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') saltato: ultimo rebuild ${age}s fa (minimo ${MIN_INTERVAL_SECONDS}s)" >>"$log"
    exit 0
  fi

  # Reap a stale lock left by a crashed run, then claim it. mkdir is atomic;
  # if another live worker holds it, back off (it will pick up the latest).
  if [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +"$STALE_LOCK_MINUTES" 2>/dev/null)" ]; then
    rmdir "$lock" 2>/dev/null || true
  fi
  mkdir "$lock" 2>/dev/null || exit 0
  trap 'rmdir "$lock" 2>/dev/null || true' EXIT

  {
    echo "=== graphify update @ $(date '+%Y-%m-%d %H:%M:%S') (${repo}) ==="
    # At agent priority (KANBAN-78): the hook fires after EVERY commit of EVERY
    # agent worktree, and a full AST re-extraction at normal priority was one of
    # the loads that made the desktop crawl on 2026-09-06 (four of them at once,
    # 30 % CPU each). nice everywhere, plus the macOS background QoS (-b) where
    # it exists.
    lowprio="nice -n 15"
    command -v taskpolicy >/dev/null 2>&1 && lowprio="taskpolicy -b $lowprio"
    if $lowprio graphify update "$repo"; then
      # Stamp only a successful run: a failed one must not hold off the retry.
      date +%s >"$out/.regen.last"
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
  } >"$log" 2>&1 || true
) </dev/null >/dev/null 2>&1 &

exit 0
