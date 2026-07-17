#!/usr/bin/env bash
#
# install-graphify-hooks.sh — wire the graphify auto-regen hooks into this
# repo's SHARED hooks directory. Idempotent; safe to re-run.
#
# Design note (why not just point core.hooksPath at scripts/git-hooks):
# topics-app already carries a broken hooksPath override in its shared config
# (pointing at a nonexistent dir), and there is ALSO a global core.hooksPath.
# A plain `--unset` would fall through to the global dir, not the repo's own
# hooks. So we install the hook files into the repo's real shared hooks dir
# ($GIT_COMMON_DIR/hooks — used by main AND every worktree) and point
# core.hooksPath explicitly at it, which deterministically overrides both the
# broken local value and the global one.

set -euo pipefail

common="$(git rev-parse --path-format=absolute --git-common-dir)"   # .../.git
case "$common" in
  */.git) repo="$(dirname "$common")" ;;
  *)      repo="$(git rev-parse --show-toplevel)" ;;
esac

src="$repo/scripts/git-hooks"
regen="$repo/scripts/graphify-regen.sh"
dest="$common/hooks"

if [ ! -d "$src" ]; then
  echo "graphify-hooks: $src not found (run from a checkout that has it)" >&2
  exit 1
fi

mkdir -p "$dest"
for h in post-commit post-merge; do
  cp "$src/$h" "$dest/$h"
  chmod +x "$dest/$h"
done
chmod +x "$regen" 2>/dev/null || true

prev="$(git config --local --get core.hooksPath || true)"
git config core.hooksPath "$dest"

echo "graphify-hooks: installed post-commit/post-merge -> $dest"
echo "graphify-hooks: core.hooksPath -> $dest"
[ -n "$prev" ] && [ "$prev" != "$dest" ] && echo "graphify-hooks: replaced previous hooksPath: $prev"
if command -v graphify >/dev/null 2>&1; then
  echo "graphify-hooks: graphify found — commits/merges will refresh graphify-out/graph.json"
else
  echo "graphify-hooks: graphify NOT on PATH — hooks are no-ops until it is installed"
fi
