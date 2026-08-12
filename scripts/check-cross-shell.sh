#!/usr/bin/env bash
# Cross-platform compile gate for the Tauri shell.
#
# Il pane browser nativo vive in `desktop-tauri/src-tauri/src/lib.rs` e ha tre
# backend (WKWebView, WebView2, WebKitGTK) selezionati da `cfg(target_os)`. Il
# compilatore ne guarda UNO SOLO alla volta: su un Mac, i rami Windows e Linux
# non vengono nemmeno letti. Una firma sbagliata lì dentro resta invisibile fino
# alla release, dove costa un giro di CI da venti minuti.
#
# Questo script compila i rami che il Mac non guarda:
#   windows → `cargo check --target x86_64-pc-windows-msvc` (webview2-com e
#             windows-rs sono binding puri Rust, quindi il check gira senza MSVC:
#             serve il linker solo per `cargo build`).
#   linux   → dentro un container Debian con webkit2gtk-4.1-dev, perche
#             webkit2gtk-sys interroga pkg-config e su macOS non trova nulla.
#
# Uso:
#   scripts/check-cross-shell.sh            # entrambi
#   scripts/check-cross-shell.sh windows    # solo Windows (veloce, no Docker)
#   scripts/check-cross-shell.sh linux      # solo Linux (richiede Docker)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHICH="${1:-all}"
RUST_IMAGE="rust:1.90-trixie"
WIN_TARGET="x86_64-pc-windows-gnu"
FAILED=0

# tauri.conf dichiara tre sidecar in `bundle.externalBin`, e tauri-build pretende
# di trovarli col suffisso della tripla di destinazione: senza, il build script
# muore con «resource path doesn't exist» PRIMA di compilare una sola riga di
# Rust. In CI li costruisce il workflow; qui non servono, perche questo e un
# cancello di COMPILAZIONE e non produce un bundle. Quindi si mettono dei
# segnaposto vuoti e si tolgono all'uscita. Un binario finto non finisce da
# nessuna parte, perche `cargo check` non linka e non impacchetta.
SIDECARS="topics-server pty-bridge webrtc-bridge"
BIN_DIR="$ROOT/desktop-tauri/src-tauri/binaries"
STAGED=""

stage_sidecars() {
  local triple="$1" ext="${2:-}"
  mkdir -p "$BIN_DIR"
  for s in $SIDECARS; do
    local f="$BIN_DIR/$s-$triple$ext"
    if [ ! -e "$f" ]; then
      : > "$f"
      STAGED="$STAGED $f"
    fi
  done
}

cleanup_sidecars() {
  for f in $STAGED; do rm -f "$f"; done
  rmdir "$BIN_DIR" 2>/dev/null || true
}
trap cleanup_sidecars EXIT

run_windows() {
  echo "==> windows: cargo check --target $WIN_TARGET"
  # Il bersaglio e `-gnu` e non `-msvc`, e la scelta merita una riga perche il
  # bersaglio VERO delle release e msvc. Il punto e che `cargo check` fa girare
  # i build script, e nella catena c'e `ring`, che compila C: per msvc servono
  # CRT e SDK di Microsoft (cargo-xwin li scarica, ma vuole llvm-lib, cioe due
  # giga di LLVM), mentre per gnu basta mingw-w64. E il codice controllato e lo
  # STESSO: i backend sono selezionati da `cfg(target_os = "windows")`, che vale
  # per entrambe le ABI, e `check` non linka mai. La differenza fra le due ABI
  # qui non arriva a esprimersi. Per la compilazione sul bersaglio vero c'e il
  # job `tauri` della CI, che gira su un runner Windows nativo.
  if ! rustup target list --installed | grep -qx "$WIN_TARGET"; then
    echo "    target mancante: rustup target add $WIN_TARGET" >&2
    return 1
  fi
  if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    echo "    toolchain C mancante: brew install mingw-w64" >&2
    return 1
  fi
  stage_sidecars "$WIN_TARGET" ".exe"
  ( cd "$ROOT/desktop-tauri/src-tauri" && cargo check --target "$WIN_TARGET" )
}

run_linux() {
  echo "==> linux: cargo check dentro $RUST_IMAGE (webkit2gtk-4.1)"
  if ! docker info >/dev/null 2>&1; then
    echo "    Docker non risponde: avvialo, oppure lancia solo 'windows'." >&2
    return 1
  fi
  # La tripla del container segue l'architettura dell'host: su Apple Silicon
  # l'immagine Linux gira arm64, quindi i segnaposto vanno nominati aarch64.
  case "$(uname -m)" in
    arm64 | aarch64) stage_sidecars "aarch64-unknown-linux-gnu" ;;
    *) stage_sidecars "x86_64-unknown-linux-gnu" ;;
  esac
  # `target-linux/` e separata da `target/`: il volume del container e la cache
  # del Mac condividerebbero altrimenti la stessa directory, e i due cargo si
  # bloccherebbero a vicenda sul file di lock.
  docker run --rm \
    -v "$ROOT:/w" \
    -v "$ROOT/desktop-tauri/src-tauri/target-linux:/target" \
    -e CARGO_TARGET_DIR=/target \
    -w /w/desktop-tauri/src-tauri \
    "$RUST_IMAGE" \
    bash -c '
      set -e
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends \
        libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
        libjavascriptcoregtk-4.1-dev pkg-config >/dev/null
      cargo check
    '
}

case "$WHICH" in
  windows) run_windows || FAILED=1 ;;
  linux)   run_linux   || FAILED=1 ;;
  all)
    run_windows || FAILED=1
    run_linux   || FAILED=1
    ;;
  *) echo "uso: $0 [windows|linux|all]" >&2; exit 2 ;;
esac

if [ "$FAILED" -ne 0 ]; then
  echo "==> CROSS-CHECK ROSSO" >&2
  exit 1
fi
echo "==> cross-check verde"
