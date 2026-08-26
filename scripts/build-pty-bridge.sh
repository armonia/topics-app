#!/usr/bin/env bash
# Compile the standalone Rust PTY bridge (desktop-tauri/pty-bridge) into a sidecar
# binary named with the Rust target triple Tauri's externalBin expects:
#   desktop-tauri/src-tauri/binaries/pty-bridge-<triple>[.exe]
#
# The compiled Bun server sidecar CANNOT run node-pty (needs Node, not Bun), so on a
# virgin install shell/claude-code tabs never opened. This ~0.5 MB binary is a
# wire-compatible port of server/pty-bridge.mjs the sidecar spawns instead (see
# desktop-tauri lib.rs bundled_pty_bridge_bin + server/routes/terminal.ts bundledBridge).
#
# macOS builds a UNIVERSAL binary (arm64 + x86_64 via lipo) to match the universal
# .app. Windows costruisce il bridge VERO: dal 2026-08-26 il trasporto e' una named
# pipe li' e un socket Unix altrove (pty-bridge/src/transport.rs). Prima era uno stub
# che usciva subito, e su Windows i terminali rispondevano 503 - in un'app che serve
# a far girare agenti da riga di comando.
#
# Usage:
#   scripts/build-pty-bridge.sh <os>       # os = macos | windows | linux (default: host)
# Run from the repo root. Requires the Rust toolchain (cargo). macOS needs both
# apple targets installed (rustup target add aarch64-apple-darwin x86_64-apple-darwin).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CRATE_DIR="desktop-tauri/pty-bridge"
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
  echo "[pty-bridge] cargo build --release --target $triple"
  ( cd "$CRATE_DIR" && cargo build --release --target "$triple" )
  local bin="$CRATE_DIR/target/$triple/release/pty-bridge"
  [ -f "$bin" ] || bin="$bin.exe"
  cp "$bin" "$OUT_DIR/$out"
  [ "${out##*.}" = "exe" ] || chmod +x "$OUT_DIR/$out"
}

case "$OS" in
  macos)
    build_target aarch64-apple-darwin pty-bridge-aarch64-apple-darwin
    build_target x86_64-apple-darwin  pty-bridge-x86_64-apple-darwin
    lipo -create \
      "$OUT_DIR/pty-bridge-aarch64-apple-darwin" \
      "$OUT_DIR/pty-bridge-x86_64-apple-darwin" \
      -output "$OUT_DIR/pty-bridge-universal-apple-darwin"
    chmod +x "$OUT_DIR"/pty-bridge-*-apple-darwin
    echo "[pty-bridge] universal:"
    lipo -info "$OUT_DIR/pty-bridge-universal-apple-darwin"
    ;;
  linux)
    build_target x86_64-unknown-linux-gnu pty-bridge-x86_64-unknown-linux-gnu
    ;;
  windows)
    build_target x86_64-pc-windows-msvc pty-bridge-x86_64-pc-windows-msvc.exe
    ;;
  *)
    echo "unknown OS '$OS' (want macos|windows|linux)" >&2
    exit 1
    ;;
esac

echo "[pty-bridge] done:"
ls -lh "$OUT_DIR"/pty-bridge-* 2>/dev/null || true
