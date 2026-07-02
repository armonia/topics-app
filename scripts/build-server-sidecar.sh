#!/usr/bin/env bash
# Compile the Bun server (server.ts) into a self-contained sidecar binary for the
# Tauri bundle, named with the Rust target triple Tauri's externalBin expects:
#   desktop-tauri/src-tauri/binaries/topics-server-<triple>[.exe]
#
# The Tauri shell spawns this sidecar on machines with no external launchd server
# (see desktop-tauri/src-tauri/src/lib.rs decide_upstream_and_spawn). It runs with
# NO_TLS + an isolated TOPICS_DATA_DIR, and embeds the DB migrations (compiled via
# migrations-embedded.ts — regenerate with scripts/gen-migrations-manifest.ts).
#
# playwright-core / chromium-bidi / electron are marked EXTERNAL: they're an
# optional server-side CDP fallback, pull unresolvable optional deps into the
# compile, and aren't needed for the standalone build (the native WKWebView pane is
# the primary browser). If a user never triggers Playwright automation, they never
# load.
#
# Usage:
#   scripts/build-server-sidecar.sh <os>
#     <os> = macos | windows | linux   (defaults to the host OS)
# Run from the repo root. Requires `bun` on PATH (and, for macos, `lipo`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="desktop-tauri/src-tauri/binaries"
mkdir -p "$OUT_DIR"

EXTERNALS=(--external playwright-core --external chromium-bidi --external electron)
ENTRY="./server.ts"

# Keep the embedded migrations manifest current before compiling — a stale manifest
# would ship an out-of-date schema into the sidecar.
bun run scripts/gen-migrations-manifest.ts

OS="${1:-}"
if [ -z "$OS" ]; then
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux)  OS=linux ;;
    *)      OS=windows ;;
  esac
fi

compile() {
  # $1 = bun --target, $2 = output path
  echo "[sidecar] bun build --compile --target=$1 -> $2"
  bun build --compile --target="$1" "${EXTERNALS[@]}" "$ENTRY" --outfile "$2"
}

case "$OS" in
  macos)
    # Universal (arm64 + x86_64), matching the universal .app. lipo the two slices.
    compile bun-darwin-arm64 "$OUT_DIR/topics-server-aarch64-apple-darwin"
    compile bun-darwin-x64   "$OUT_DIR/topics-server-x86_64-apple-darwin"
    lipo -create \
      "$OUT_DIR/topics-server-aarch64-apple-darwin" \
      "$OUT_DIR/topics-server-x86_64-apple-darwin" \
      -output "$OUT_DIR/topics-server-universal-apple-darwin"
    # Tauri's externalBin for `--target universal-apple-darwin` looks for the
    # -universal-apple-darwin suffix; the per-arch slices can stay (harmless) but
    # the universal one is what the bundle picks up.
    chmod +x "$OUT_DIR"/topics-server-*-apple-darwin
    echo "[sidecar] universal:"
    lipo -info "$OUT_DIR/topics-server-universal-apple-darwin"
    ;;
  windows)
    compile bun-windows-x64 "$OUT_DIR/topics-server-x86_64-pc-windows-msvc.exe"
    ;;
  linux)
    compile bun-linux-x64 "$OUT_DIR/topics-server-x86_64-unknown-linux-gnu"
    chmod +x "$OUT_DIR/topics-server-x86_64-unknown-linux-gnu"
    ;;
  *)
    echo "unknown OS '$OS' (want macos|windows|linux)" >&2
    exit 1
    ;;
esac

echo "[sidecar] done:"
ls -lh "$OUT_DIR"
