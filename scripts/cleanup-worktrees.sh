#!/usr/bin/env bash
# cleanup-worktrees.sh — Remove all agent worktrees and their branches.
# Usage: ./scripts/cleanup-worktrees.sh [--dry-run]
#
# Finds all git worktrees under .claude/worktrees/agent-* and removes them
# along with their associated branches. Safe to run repeatedly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[dry-run] Would remove the following worktrees:"
fi

# Collect agent worktrees (skip the main worktree line)
WORKTREES=()
while IFS= read -r line; do
  path=$(echo "$line" | awk '{print $1}')
  branch=$(echo "$line" | awk '{print $3}' | tr -d '[]')
  WORKTREES+=("$path|$branch")
done < <(git worktree list | grep 'agent-')

if [[ ${#WORKTREES[@]} -eq 0 ]]; then
  echo "No agent worktrees found. Nothing to clean up."
  exit 0
fi

removed=0
failed=0

for entry in "${WORKTREES[@]}"; do
  path="${entry%%|*}"
  branch="${entry##*|}"

  if $DRY_RUN; then
    echo "  worktree: $path  branch: $branch"
    ((removed++))
    continue
  fi

  echo "Removing worktree: $path"
  if git worktree remove --force "$path" 2>/dev/null; then
    echo "  Removed worktree: $path"
  else
    echo "  Warning: Could not remove worktree $path (may already be gone)"
  fi

  if git branch -D "$branch" 2>/dev/null; then
    echo "  Deleted branch: $branch"
    ((removed++))
  else
    echo "  Warning: Could not delete branch $branch (may already be gone)"
    ((failed++))
  fi
done

# Prune stale worktree references
if ! $DRY_RUN; then
  git worktree prune 2>/dev/null || true
fi

echo ""
echo "Done. Removed: $removed  Failed: $failed"
