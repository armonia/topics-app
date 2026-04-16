#!/usr/bin/env bash
# Phase 30 PANE-05 production-strip contract.
# Asserts that the production client bundle in client/dist/ does NOT contain
# the dev-only mutation-log symbols. If found, CI must fail.
#
# Usage:
#   ./scripts/assert-dev-overlay-stripped.sh           # uses client/dist
#   ./scripts/assert-dev-overlay-stripped.sh ./public  # custom dir (if Vite outDir differs)
set -euo pipefail

DIST_DIR="${1:-client/dist}"

if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: bundle dir '$DIST_DIR' does not exist. Run 'cd client && npm run build' first."
  exit 2
fi

# Guard against a stale or empty directory silently passing the strip check
# (review I6: a never-built bundle dir would match zero forbidden symbols and
# exit 0, which is misleading). Require at least one .js file before we even
# start the symbol scan.
if ! find "$DIST_DIR" \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -type f -print -quit | grep -q .; then
  echo "ERROR: no .js/.mjs/.cjs files found under '$DIST_DIR'. The bundle was not built; refusing to declare strip contract satisfied."
  exit 2
fi

# Symbols and import paths that MUST NOT appear in production bundles.
# Greping import specifiers (devOverlay, mutationLog module) catches
# accidental un-guarded imports that would otherwise pull the module into the
# graph even if the symbol itself is minified away.
FORBIDDEN_SYMBOLS=(
  "recordAction"
  "usePaneMutationLog"
  "MutationLogOverlay"
  "state/pane/devOverlay"
  "state/pane/middleware/mutationLog"
)

FAIL=0
for sym in "${FORBIDDEN_SYMBOLS[@]}"; do
  if grep -r --include="*.js" --include="*.mjs" --include="*.cjs" -l "$sym" "$DIST_DIR" >/dev/null 2>&1; then
    echo "FAIL: forbidden symbol '$sym' found in production bundle ($DIST_DIR)"
    grep -r --include="*.js" --include="*.mjs" --include="*.cjs" -l "$sym" "$DIST_DIR"
    FAIL=1
  fi
done

if [ $FAIL -eq 1 ]; then
  echo ""
  echo "PANE-05 strip contract violated: dev-only mutation-log code leaked into production."
  echo "Verify that:"
  echo "  - recordAction calls are guarded by 'import.meta.env.DEV'"
  echo "  - MutationLogOverlay is rendered only behind '{import.meta.env.DEV && ...}'"
  echo "  - The devOverlay module is imported only from a DEV-guarded site"
  exit 1
fi

echo "OK: PANE-05 strip contract satisfied. No dev-only mutation-log symbols in $DIST_DIR."
