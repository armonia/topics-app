#!/usr/bin/env bash
#
# install-cli.sh — Phase H · build the `topics` CLI binary and symlink it
# into a directory on PATH.
#
# Usage:
#   bash scripts/install-cli.sh                 # default: ~/.local/bin
#   bash scripts/install-cli.sh /usr/local/bin  # explicit destination
#
# Idempotent: re-running rebuilds the binary and replaces the symlink.
#
# Requires bun (>= 1.1) on PATH. The compiled binary is self-contained;
# no Node runtime is needed at the install site after build.

set -euo pipefail

# ── Resolve repo root ────────────────────────────────────────────────────
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_ROOT}"

# ── Sanity ───────────────────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not installed. See https://bun.sh" >&2
  exit 1
fi
if [[ ! -f "cli/topics.ts" ]]; then
  echo "error: cli/topics.ts not found. Run from repo root or check the layout." >&2
  exit 1
fi

DEST="${1:-${HOME}/.local/bin}"
mkdir -p "${DEST}"
mkdir -p dist

# ── Build ────────────────────────────────────────────────────────────────
echo "[install-cli] Building dist/topics …"
bun build cli/topics.ts --compile --outfile dist/topics

# ── Symlink ──────────────────────────────────────────────────────────────
LINK="${DEST}/topics"
if [[ -L "${LINK}" ]] || [[ -f "${LINK}" ]]; then
  rm -f "${LINK}"
fi
ln -s "${REPO_ROOT}/dist/topics" "${LINK}"
echo "[install-cli] Symlinked ${LINK} → ${REPO_ROOT}/dist/topics"

# ── PATH check ───────────────────────────────────────────────────────────
case ":${PATH}:" in
  *":${DEST}:"*)
    echo "[install-cli] ${DEST} is on PATH — try: topics --help"
    ;;
  *)
    echo "[install-cli] WARNING: ${DEST} is NOT on your PATH."
    echo "  Add this to your shell rc:"
    echo "    export PATH=\"${DEST}:\$PATH\""
    ;;
esac

echo "[install-cli] Done."
