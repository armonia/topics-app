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
#   - SILENT NO-OP when graphify is not installed or no graph exists yet.
#
# Nothing here ever exits non-zero into the hook: a broken graph must not be
# able to block a commit.

set -u

DEBOUNCE_SECONDS="${GRAPHIFY_REGEN_DEBOUNCE:-30}"
STALE_LOCK_MINUTES=30

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
    # 30 % CPU each). nice everywhere, plus the macOS QoS clamp where it exists.
    lowprio="nice -n 15"
    command -v taskpolicy >/dev/null 2>&1 && lowprio="taskpolicy -c utility $lowprio"
    $lowprio graphify update "$repo"

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
