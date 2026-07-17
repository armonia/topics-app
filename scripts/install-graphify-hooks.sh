#!/usr/bin/env bash
#
# install-graphify-hooks.sh — wire the graphify auto-regen hooks into the
# primary checkout of this repo. Idempotent; safe to re-run.
#
# It points git's core.hooksPath at the version-controlled scripts/git-hooks
# directory. We use core.hooksPath (not a copy into .git/hooks) so the hooks
# stay tracked and update with the repo. This is a shared/common setting, so it
# applies to every worktree of this repo — which is what we want: any commit,
# on any worktree, refreshes the primary checkout's graph.
#
# NOTE: if core.hooksPath was previously set to something else, this replaces
# it. On topics-app it was pointing at a stale, nonexistent directory (so no
# hooks were firing at all), which is exactly why the graph went stale.

set -euo pipefail

# Resolve the primary worktree root (where the graph and scripts live).
common="$(git rev-parse --path-format=absolute --git-common-dir)"
case "$common" in
  */.git) repo="$(dirname "$common")" ;;
  *)      repo="$(git rev-parse --show-toplevel)" ;;
esac

hooks_dir="$repo/scripts/git-hooks"
regen="$repo/scripts/graphify-regen.sh"

if [ ! -d "$hooks_dir" ]; then
  echo "graphify-hooks: $hooks_dir not found (run from a checkout that has it)" >&2
  exit 1
fi

chmod +x "$hooks_dir"/post-commit "$hooks_dir"/post-merge "$regen" 2>/dev/null || true

prev="$(git config --local --get core.hooksPath || true)"
git config core.hooksPath "$hooks_dir"

echo "graphify-hooks: core.hooksPath -> $hooks_dir"
[ -n "$prev" ] && [ "$prev" != "$hooks_dir" ] && echo "graphify-hooks: replaced previous hooksPath: $prev"
if command -v graphify >/dev/null 2>&1; then
  echo "graphify-hooks: graphify found — commits/merges will refresh graphify-out/graph.json"
else
  echo "graphify-hooks: graphify NOT on PATH — hooks are no-ops until it is installed"
fi
