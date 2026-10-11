#!/usr/bin/env bash
# Compile the Bun server into a self-contained sidecar binary for the
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
# NOT server.ts: the entry is a two-branch shim (server/sidecar-entry.ts) so the
# SAME binary can also be the detached ai-bridge daemon when it is spawned with
# `--ai-bridge-daemon`. Without it the installed app has no runtime to run the
# daemon script with, and the old argv started a second server instead.
ENTRY="./server/sidecar-entry.ts"

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

# ── smoke: build a HOST binary and run it in FULL isolation, then verify + clean up.
#
# DANGER the isolation guards against: the PTY-bridge socket is md5(cwd) when
# DATA_DIR is unset (server/routes/terminal.ts). Running a sidecar from the repo
# root with a bare cwd hashes to the SAME socket as a live launchd/dev server and
# reconcile-kills its live PTYs (the 2026-07-02 incident). So EVERY manual smoke
# MUST run through this path — it sets a private socket, DATA_DIR, HOME, a high port,
# AND the standalone kill-switch, and never runs from the repo cwd's default socket.
if [ "$OS" = "smoke" ]; then
  # The host's own target: CI smokes the three shipped systems (sidecar-smoke.yml),
  # and Git Bash on Windows reports MINGW*/MSYS*, which used to fall to linux-x64.
  ARCH="$(uname -m | grep -qE 'arm64|aarch64' && echo arm64 || echo x64)"
  EXE=""
  case "$(uname -s)" in
    Darwin) HOST_TARGET="bun-darwin-$ARCH" ;;
    Linux)  HOST_TARGET="bun-linux-$ARCH" ;;
    *)      HOST_TARGET="bun-windows-x64"; EXE=".exe" ;;
  esac
  WORK="$(mktemp -d)"
  BIN="$WORK/topics-server-smoke$EXE"
  PORT="${SMOKE_PORT:-13460}"
  SOCK="/tmp/sidecar-smoke-$$-$RANDOM.sock"
  echo "[smoke] compiling host binary ($HOST_TARGET) -> $BIN"
  bun build --compile --target="$HOST_TARGET" "${EXTERNALS[@]}" "$ENTRY" --outfile "$BIN"
  echo "[smoke] launching ISOLATED: port=$PORT socket=$SOCK data=$WORK/data home=$WORK/home (bridge DISABLED)"
  NO_TLS=1 BUN_PORT="$PORT" SERVER_HOST=127.0.0.1 \
    TOPICS_DATA_DIR="$WORK/data" DATA_DIR="$WORK/data/data" TOPICS_HOME="$WORK/home" \
    TOPICS_PTY_SOCKET="$SOCK" TOPICS_DISABLE_PTY_BRIDGE=1 TOPICS_EMBEDDED=1 HOME="$WORK/fakehome" \
    "$BIN" > "$WORK/smoke.log" 2>&1 &
  SMOKE_PID=$!
  # Wait for the binary to exit before removing its data dir: one still writing
  # there made `rm -rf` fail ("Directory not empty") and the smoke exit 1.
  # The verdict is already printed when this runs, so the binary's own exit status
  # is not one: on Windows `kill` is TerminateProcess, no SIGTERM handler runs,
  # `wait` reports 143 and `set -e` turned a passed smoke into exit 143.
  cleanup_smoke() { kill "$SMOKE_PID" 2>/dev/null; wait "$SMOKE_PID" 2>/dev/null || true; rm -rf "$WORK"; rm -f "$SOCK"; }
  trap cleanup_smoke EXIT
  # Wait for the API.
  ok=""
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/topics" 2>/dev/null; then ok=1; break; fi
    sleep 0.25
  done
  if [ -z "$ok" ]; then echo "[smoke] FAIL: server never answered"; tail -30 "$WORK/smoke.log"; exit 1; fi
  topics_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/topics)"
  sessions_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/terminal/sessions)"
  echo "[smoke] /api/topics: $topics_code"
  echo "[smoke] /api/terminal/sessions (expect 503 standalone): $sessions_code"
  # The binary's stdout reaches the file after it already answers: grepping at
  # once read an empty log 4 times in 6 (T12, both Buns). Wait up to 5 s for it.
  for _ in $(seq 1 20); do
    grep -qE "embedded migration|All migrations" "$WORK/smoke.log" && break
    sleep 0.25
  done
  echo "[smoke] migrations line:"; grep -E "embedded migration|All migrations" "$WORK/smoke.log" | head -1
  # A gate, not a printout (CI runs it on every server change): a schema that did
  # not build answers 500, and a 200 on the sessions route means the bridge is live.
  fail=""
  [ "$topics_code" = "200" ] || fail="/api/topics answered $topics_code"
  [ "$sessions_code" = "503" ] || fail="${fail:+$fail; }/api/terminal/sessions answered $sessions_code"
  grep -qE "embedded migration|All migrations" "$WORK/smoke.log" || fail="${fail:+$fail; }no migrations line in the log"
  grep -qi "PTY bridge daemon" "$WORK/smoke.log" && fail="${fail:+$fail; }the standalone binary reached a PTY bridge"
  if [ -n "$fail" ]; then echo "[smoke] FAIL: $fail"; tail -30 "$WORK/smoke.log"; exit 1; fi
  echo "[smoke] OK"
  exit 0
fi

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
