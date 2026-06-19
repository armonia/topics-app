#!/usr/bin/env bash
# organize-test-videos.sh — Renames Playwright video artifacts into a clean structure:
#   test-results/videos/{spec-name}/{scenario-slug}.webm
#
# Usage: ./scripts/organize-test-videos.sh [artifacts-dir]

set -euo pipefail

cd "$(dirname "$0")/.."

ARTIFACTS="${1:-test-results/artifacts}"
OUTDIR="test-results/videos"

if [ ! -d "$ARTIFACTS" ]; then
  echo "No artifacts directory found at $ARTIFACTS — nothing to organize."
  exit 0
fi

# Map test file basenames → spec slugs
declare -A FILE_TO_SPEC=(
  [agent-management]=agents
  [chat]=chat
  [chat-checkpoints]=chat
  [chat-scroll]=chat
  [command-palette]=commands
  [context-settings]=context
  [context-and-layout]=context
  [dashboard]=dashboard
  [file-explorer]=files
  [file-context-menu]=files
  [grid-split]=layout
  [layout-edge-cases]=layout
  [layout-fixes]=layout
  [layout-navigation]=layout
  [kanban-board]=kanban
  [terminal]=terminal
  [topic-management]=topics
  [topic-management-org]=topics
  [panels]=layout
  [sidebar]=layout
  [mobile-responsive]=layout
  [browser-process]=system
  [cross-feature]=system
  [infra-panels]=system
  [infra-validation]=system
  [project-tabs]=layout
  [push-notifications]=system
  [real-tool-calls]=chat
  [regression-fixes]=system
  [split-screen-sync]=layout
  [system]=system
  [tab-drag-regression]=layout
  [tab-sync]=layout
  [tool-call-rendering]=chat
  [unread-clearing]=chat
  [master-topic]=master-topic
  [master-session-ui]=master-topic
  [notifications-non-invasive]=notifications
)

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}

count=0

# Playwright stores videos in per-test dirs like:
#   test-results/artifacts/spec-name-Test-Title-chromium/video.webm
# or sometimes nested. We find all .webm files.
while read -r video; do
  # The parent directory name encodes the test info
  dirbase="$(basename "$(dirname "$video")")"

  # Try to extract the spec file name and test title from the directory name
  # Format: {spec-file-base}-{Test-Title}-{browser}
  # e.g. "chat-Send-message-and-receive-streamed-response-chromium"
  
  # Strip browser suffix
  cleaned="$dirbase"
  for browser in chromium firefox webkit mobile; do
    cleaned="${cleaned%-$browser}"
  done

  # Find the best matching spec file prefix
  matched_spec=""
  matched_title=""
  best_len=0

  for filebase in "${!FILE_TO_SPEC[@]}"; do
    if [[ "$cleaned" == "$filebase-"* ]]; then
      if [ ${#filebase} -gt $best_len ]; then
        best_len=${#filebase}
        matched_spec="${FILE_TO_SPEC[$filebase]}"
        matched_title="${cleaned#$filebase-}"
      fi
    fi
  done

  if [ -z "$matched_spec" ]; then
    # Fallback: use directory name as-is
    matched_spec="other"
    matched_title="$cleaned"
  fi

  slug="$(slugify "$matched_title")"
  [ -z "$slug" ] && slug="unknown"

  mkdir -p "$OUTDIR/$matched_spec"

  dest="$OUTDIR/$matched_spec/$slug.webm"
  # Handle duplicates
  if [ -f "$dest" ]; then
    i=2
    while [ -f "$OUTDIR/$matched_spec/${slug}-${i}.webm" ]; do ((i++)); done
    dest="$OUTDIR/$matched_spec/${slug}-${i}.webm"
  fi

  cp "$video" "$dest"
  ((count++)) || true
  echo "  → $dest"
done < <(find "$ARTIFACTS" -name '*.webm' -type f)

echo "Organized $count video(s) into $OUTDIR/"
