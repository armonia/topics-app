#!/usr/bin/env bash
# e2e-isolated-bundle.sh — build the client bundle the E2E suite needs, from a
# tree nobody else is editing, and hand back the variable that points the suite
# at it.
#
# WHY IT EXISTS. `tests/e2e/global-setup.ts` refuses to run against a stale
# `public/`, and it is right to: the suite would test the code of an hour ago and
# a green would mean nothing. Its message then tells you to build elsewhere, and
# on a machine where another session has client files open that is the only safe
# move, because `vite build` reads the working tree and would bake somebody's
# half-finished work into the bundle under test.
#
# THE STEP THAT IS EASY TO MISS, and the reason this is a script and not a note:
# `bun install` in `client/` is not enough. `shared/` imports root dependencies,
# so the build dies with
#
#     [vite]: Rollup failed to resolve import "zod/mini" from ".../shared/ws-outbound.ts"
#
# and the failure names a file you did not touch, in a directory you did not
# build. Both installs are needed, in that order.
#
# WHAT IT COPIES: `git archive HEAD`, so COMMITTED content only. Uncommitted work
# (yours or anyone else's) is deliberately left out. Commit first if you want it
# tested.
#
# Usage:
#   scripts/e2e-isolated-bundle.sh                    # build (or reuse) and print the export line
#   scripts/e2e-isolated-bundle.sh --run tests/e2e/chat-*.spec.ts
#   TOPICS_E2E_SRC_DIR=/somewhere scripts/e2e-isolated-bundle.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${TOPICS_E2E_SRC_DIR:-${TMPDIR:-/tmp}/topics-e2e-src}"
SRC_DIR="${SRC_DIR%/}"
STAMP="$SRC_DIR/.built-from-sha"

die() { echo "✗ $*" >&2; exit 1; }

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# Reuse: the expensive part is the two installs, not the 8s build. If the tree
# already came from this exact commit and produced a bundle, there is nothing to
# redo. Any other commit means a full rebuild, because a partial refresh is how
# you end up testing a mix of two trees.
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$HEAD_SHA" ] && [ -f "$SRC_DIR/public/index.html" ]; then
  echo "▸ riuso il bundle di ${HEAD_SHA:0:9} (già in $SRC_DIR)"
else
  echo "▸ 1/4  estraggo HEAD (${HEAD_SHA:0:9}) in $SRC_DIR — solo contenuto committato"
  rm -rf "$SRC_DIR"
  mkdir -p "$SRC_DIR"
  git -C "$REPO_ROOT" archive HEAD | tar -x -C "$SRC_DIR"

  echo "▸ 2/4  bun install nella RADICE (shared/ importa dipendenze di root)"
  (cd "$SRC_DIR" && bun install --silent) || die "install di radice fallito"

  echo "▸ 3/4  bun install in client/"
  (cd "$SRC_DIR/client" && bun install --silent) || die "install del client fallito"

  # The export has no .git, so vite's own `git rev-parse` fails and the build sha
  # (the only thing that identifies a bundle after the fact) would come out empty.
  # We know the sha: hand it over.
  echo "▸ 4/4  vite build"
  (cd "$SRC_DIR/client" && TOPICS_BUILD_SHA="${HEAD_SHA:0:9}" ./node_modules/.bin/vite build >/dev/null) \
    || die "build del client fallito (rilancia senza >/dev/null per vedere l'errore)"

  [ -f "$SRC_DIR/public/index.html" ] || die "nessun public/index.html prodotto"
  echo "$HEAD_SHA" > "$STAMP"
fi

BUNDLE="$SRC_DIR/public"

if [ "${1:-}" = "--run" ]; then
  shift
  [ "$#" -gt 0 ] || die "--run vuole almeno una spec (o un percorso)"
  echo
  echo "▸ playwright, con TOPICS_E2E_BUNDLE_DIR=$BUNDLE"
  cd "$REPO_ROOT"
  TOPICS_E2E_BUNDLE_DIR="$BUNDLE" exec npx playwright test "$@"
fi

echo
echo "Bundle pronto. Per usarlo:"
echo
echo "    TOPICS_E2E_BUNDLE_DIR=$BUNDLE npx playwright test <spec>"
echo
echo "Oppure in un colpo solo:"
echo
echo "    scripts/e2e-isolated-bundle.sh --run <spec>"
