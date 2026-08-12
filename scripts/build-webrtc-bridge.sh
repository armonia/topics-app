#!/usr/bin/env bash
# Compile the standalone Rust WebRTC bridge (desktop-tauri/webrtc-bridge) into a
# sidecar binary named with the Rust target triple Tauri's externalBin expects:
#   desktop-tauri/src-tauri/binaries/webrtc-bridge-<triple>[.exe]
#
# WHY this has to ship in the bundle: the shared-session browser pane renders an H.264
# <video> served by this bridge (client/src/hooks/useRemoteBrowser.ts) — it is THE
# transport for non-framable pages, not an extra. The compiled Bun server cannot hold
# an openh264 encoder / webrtc-rs stack in-process, so it spawns this binary
# (server/webrtc-bridge.ts, picked via TOPICS_WEBRTC_BRIDGE_BIN). Without the sidecar
# in the bundle, `available()` is false on every virgin install and the pane degrades
# to the DOM fallback — i.e. the feature simply isn't there for shipped users.
#
# macOS builds a UNIVERSAL binary (arm64 + x86_64 via lipo) to match the universal
# .app. Windows compiles to a no-op stub (the wire protocol is a Unix socket) purely so
# the externalBin bundle resolves a binary for every target; lib.rs never advertises it
# there. The heavy deps (webrtc-rs, openh264) are `cfg(unix)`-scoped in Cargo.toml, so
# the Windows stub compiles in seconds.
#
# Usage:
#   scripts/build-webrtc-bridge.sh <os>     # os = macos | windows | linux (default: host)
# Run from the repo root. Requires the Rust toolchain (cargo) and, on macOS, both
# apple targets (rustup target add aarch64-apple-darwin x86_64-apple-darwin).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CRATE_DIR="desktop-tauri/webrtc-bridge"
OUT_DIR="desktop-tauri/src-tauri/binaries"
mkdir -p "$OUT_DIR"

OS="${1:-}"
if [ -z "$OS" ]; then
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux)  OS=linux ;;
    *)      OS=windows ;;
  esac
fi

# Build one target and copy its binary out with the triple-suffixed name.
#   $1 = rust target triple, $2 = output basename (with .exe on windows)
build_target() {
  local triple="$1" out="$2"
  echo "[webrtc-bridge] cargo build --release --target $triple"
  ( cd "$CRATE_DIR" && cargo build --release --target "$triple" )
  local bin="$CRATE_DIR/target/$triple/release/webrtc-bridge"
  [ -f "$bin" ] || bin="$bin.exe"
  cp "$bin" "$OUT_DIR/$out"
  [ "${out##*.}" = "exe" ] || chmod +x "$OUT_DIR/$out"
}

case "$OS" in
  macos)
    build_target aarch64-apple-darwin webrtc-bridge-aarch64-apple-darwin
    build_target x86_64-apple-darwin  webrtc-bridge-x86_64-apple-darwin
    lipo -create \
      "$OUT_DIR/webrtc-bridge-aarch64-apple-darwin" \
      "$OUT_DIR/webrtc-bridge-x86_64-apple-darwin" \
      -output "$OUT_DIR/webrtc-bridge-universal-apple-darwin"
    chmod +x "$OUT_DIR"/webrtc-bridge-*-apple-darwin
    echo "[webrtc-bridge] universal:"
    lipo -info "$OUT_DIR/webrtc-bridge-universal-apple-darwin"
    ;;
  linux)
    build_target x86_64-unknown-linux-gnu webrtc-bridge-x86_64-unknown-linux-gnu
    ;;
  windows)
    build_target x86_64-pc-windows-msvc webrtc-bridge-x86_64-pc-windows-msvc.exe
    ;;
  *)
    echo "unknown OS '$OS' (want macos|windows|linux)" >&2
    exit 1
    ;;
esac

echo "[webrtc-bridge] done:"
ls -lh "$OUT_DIR"/webrtc-bridge-* 2>/dev/null || true
