#!/usr/bin/env bash
# Stage the bundled PTY runtime the Tauri sidecar spawns for terminals on a fresh
# install: an OFFICIAL (self-contained) Node runtime + pty-bridge.mjs + node-pty
# with its N-API prebuilds, laid out so `node pty-bridge.mjs` resolves node-pty.
#
#   desktop-tauri/src-tauri/pty-runtime/
#     node                                   (or node.exe on Windows)
#     pty-bridge.mjs                         (copy of server/pty-bridge.mjs)
#     node_modules/node-pty/{package.json,lib,prebuilds}
#
# tauri.conf.json lists `pty-runtime` under bundle.resources, so it lands in
# `<App>/Contents/Resources/pty-runtime` and desktop-tauri lib.rs bundled_pty_runtime()
# points the standalone server at it (TOPICS_NODE_BIN + TOPICS_PTY_BRIDGE_PATH).
#
# WHY an official Node and not `which node`: Homebrew's node dynamically links
# Homebrew dylibs (icu4c, …) absent on an end-user machine — it would ENOENT its
# own libs. The nodejs.org dists are self-contained. node-pty is N-API, so ABI is
# stable across Node majors and this version is not load-bearing.
#
# Usage:  scripts/stage-pty-runtime.sh [macos|windows|linux]   (default: host OS)
# Run from the repo root. Requires curl + tar (+ lipo for the mac universal).
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v22.14.0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="desktop-tauri/src-tauri/pty-runtime"
CACHE="${TMPDIR:-/tmp}/topics-node-dist"
mkdir -p "$CACHE"

OS="${1:-}"
if [ -z "$OS" ]; then
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux)  OS=linux ;;
    *)      OS=windows ;;
  esac
fi

# Download + extract just the `node` binary for one nodejs.org dist arch.
#   $1 = dist id (e.g. darwin-arm64, linux-x64, win-x64) → echoes the extracted path
fetch_node() {
  local dist="$1"
  local ext="tar.gz"; local binrel="bin/node"
  case "$dist" in
    win-*) ext="zip"; binrel="node.exe" ;;
  esac
  local name="node-${NODE_VERSION}-${dist}"
  local url="https://nodejs.org/dist/${NODE_VERSION}/${name}.${ext}"
  local archive="$CACHE/${name}.${ext}"
  local extracted="$CACHE/${name}/${binrel}"
  if [ ! -f "$extracted" ]; then
    echo "[pty-runtime] downloading $url" >&2
    curl -fSL "$url" -o "$archive"
    if [ "$ext" = "zip" ]; then unzip -oq "$archive" -d "$CACHE"; else tar -xzf "$archive" -C "$CACHE"; fi
  fi
  echo "$extracted"
}

# Stage the shared bits (bridge script + pruned node-pty) into $OUT_DIR.
stage_common() {
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR/node_modules/node-pty"
  cp server/pty-bridge.mjs "$OUT_DIR/pty-bridge.mjs"
  # node-pty runtime surface only: package.json + lib/ + prebuilds/. (loadNativeModule
  # resolves prebuilds/<platform>-<arch>/pty.node relative to lib/; nothing else is
  # required at runtime — no bindings/node-addon-api.)
  local src="node_modules/node-pty"
  [ -d "$src" ] || { echo "[pty-runtime] ERROR: $src missing — run bun install" >&2; exit 1; }
  cp "$src/package.json" "$OUT_DIR/node_modules/node-pty/package.json"
  cp -R "$src/lib" "$OUT_DIR/node_modules/node-pty/lib"
  cp -R "$src/prebuilds" "$OUT_DIR/node_modules/node-pty/prebuilds"
}

echo "[pty-runtime] staging for $OS (node ${NODE_VERSION}) -> $OUT_DIR"
stage_common

case "$OS" in
  macos)
    ARM="$(fetch_node darwin-arm64)"
    X64="$(fetch_node darwin-x64)"
    # Universal node matching the universal .app — lipo the two slices.
    lipo -create "$ARM" "$X64" -output "$OUT_DIR/node"
    chmod +x "$OUT_DIR/node"
    lipo -info "$OUT_DIR/node"
    # node-pty ships universal prebuilds already (darwin-arm64 + darwin-x64 dirs);
    # loadNativeModule picks the right one by process.arch at runtime.
    chmod +x "$OUT_DIR"/node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true
    ;;
  linux)
    BIN="$(fetch_node linux-x64)"
    cp "$BIN" "$OUT_DIR/node"; chmod +x "$OUT_DIR/node"
    if [ ! -d "$OUT_DIR/node_modules/node-pty/prebuilds/linux-x64" ]; then
      echo "[pty-runtime] WARN: no linux-x64 node-pty prebuild present — terminals will not load on Linux until one is built (npm rebuild node-pty on linux)." >&2
    fi
    ;;
  windows)
    BIN="$(fetch_node win-x64)"
    cp "$BIN" "$OUT_DIR/node.exe"
    # Windows node-pty uses winpty/conpty DLLs, not spawn-helper; prebuilds/win32-x64
    # must carry them. (Present in the repo's node_modules.)
    ;;
  *)
    echo "unknown OS '$OS' (want macos|windows|linux)" >&2; exit 1 ;;
esac

echo "[pty-runtime] done:"
find "$OUT_DIR" -maxdepth 2 -type f | sed 's/^/  /'
du -sh "$OUT_DIR" | sed 's/^/  total /'
