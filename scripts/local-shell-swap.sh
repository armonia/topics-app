#!/usr/bin/env bash
# local-shell-swap.sh — porta un fix NATIVO (Rust/lib.rs) nella Topics.app
# locale senza aspettare la CI, e senza far ripartire i permessi da zero.
#
# PERCHÉ ESISTE. Il binario Tauri è self-contained: `public/` ci finisce dentro
# con `include_bytes!` a cargo-build, quindi per consegnare un fix basta
# ricostruire il Mach-O e scambiarlo nel `.app` esistente (che fornisce
# Info.plist, Resources, icone). Non serve `cargo tauri build`.
#
# LA FIRMA È IL PUNTO. Fatto a mano, questo giro finiva regolarmente in
# `codesign --sign -` — ADHOC. E una firma adhoc lega il requisito designato
# all'hash di QUELLA build:
#
#     designated => cdhash H"17c0b00a…"
#
# Cioè a ogni ricompilazione macOS vede un'applicazione DIVERSA, e TCC
# ripropone da capo notifiche, registrazione schermo, accessibilità, Full Disk
# Access. Firmando invece con un'identità stabile il requisito diventa:
#
#     designated => identifier "io.armonia.topics.tauri" and certificate leaf = H"…"
#
# che resta vero per ogni build futura firmata con lo stesso certificato: i
# permessi si concedono UNA volta. Il certificato può essere autofirmato — non
# serve pagare Apple; serve solo che sia SEMPRE LO STESSO.
#
# USO
#   ./scripts/local-shell-swap.sh                 # identità di default (sotto)
#   SIGN_IDENTITY="Altro Nome" ./scripts/local-shell-swap.sh
#
# Se l'identità non esiste, lo script si ferma e spiega come crearne una — non
# ripiega in silenzio su adhoc, che è esattamente il male che vuole evitare.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${TOPICS_APP:-$HOME/Applications/Topics.app}"
SIGN_IDENTITY="${SIGN_IDENTITY:-Topics Signing}"
BUNDLE_ID="io.armonia.topics.tauri"

die() { echo "✗ $*" >&2; exit 1; }

[ -d "$APP" ] || die "Topics.app non trovata in $APP (override: TOPICS_APP=…)"

if ! security find-identity -v -p codesigning | grep -qF "$SIGN_IDENTITY"; then
  cat >&2 <<EOF
✗ Nessuna identità di firma "$SIGN_IDENTITY" nel portachiavi.

  Serve un certificato di code signing STABILE — autofirmato va benissimo, non
  serve un account Apple a pagamento. L'unica proprietà che conta è che non
  cambi: se cambia, macOS richiede di nuovo tutti i permessi.

  Quello di Topics è "Topics Signing" (autofirmato, scade nel 2036). Se manca da
  questo portachiavi, reimportalo dalla copia salvata:

    security import ~/.topics/signing/topics-signing.p12 \\
      -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign \\
      -P "\$(security find-generic-password -a topics-signing-p12 -w)"

  È LO STESSO certificato che firma le release (secret APPLE_CERTIFICATE): se ne
  usi un altro, l'app locale e quella aggiornata sono due identità diverse per
  macOS e i permessi ripartono da zero.

  Oppure indica un'identità già tua:
    SIGN_IDENTITY="Nome esistente" $0
EOF
  exit 1
fi

echo "▸ 1/5  bundle del client → public/ (finisce dentro il binario)"
(cd "$REPO_ROOT/client" && ./node_modules/.bin/vite build >/dev/null)

echo "▸ 2/5  cargo build --release"
(cd "$REPO_ROOT/desktop-tauri/src-tauri" && "$HOME/.cargo/bin/cargo" build --release)

BIN="$REPO_ROOT/desktop-tauri/src-tauri/target/release/app"
[ -f "$BIN" ] || die "binario non prodotto: $BIN"

# Il bundle appena costruito dev'essere DAVVERO dentro il binario: senza questo
# controllo si può scambiare un Mach-O che embedda una `public/` vecchia, e il
# sintomo (UI stantia) sembra un problema di cache.
ASSET="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$REPO_ROOT/public/index.html" | head -1 || true)"
if [ -n "$ASSET" ] && ! strings "$BIN" 2>/dev/null | grep -q "$(basename "$ASSET")"; then
  die "il binario non contiene il bundle appena costruito ($ASSET)"
fi
echo "  ✓ bundle embeddato verificato ($ASSET)"

echo "▸ 3/5  backup + swap del Mach-O"
BACKUP="${TMPDIR:-/tmp}/topics-app-$(date +%Y%m%d-%H%M%S).bak"
cp -p "$APP/Contents/MacOS/app" "$BACKUP"
echo "  backup: $BACKUP"

if pgrep -f "$APP/Contents/MacOS/app" >/dev/null; then
  pkill -f "$APP/Contents/MacOS/app" || true
  for _ in $(seq 1 20); do
    pgrep -f "$APP/Contents/MacOS/app" >/dev/null || break
    sleep 0.5
  done
  pgrep -f "$APP/Contents/MacOS/app" >/dev/null && pkill -9 -f "$APP/Contents/MacOS/app" || true
fi

# Scrivi accanto e poi `mv`: uno swap a metà lascerebbe un .app che non parte.
cp "$BIN" "$APP/Contents/MacOS/app.new"
mv -f "$APP/Contents/MacOS/app.new" "$APP/Contents/MacOS/app"

echo "▸ 4/5  firma con «$SIGN_IDENTITY»"
codesign --remove-signature "$APP" 2>/dev/null || true
codesign --force --deep --sign "$SIGN_IDENTITY" --identifier "$BUNDLE_ID" "$APP"
codesign --verify --deep --strict "$APP" || die "verifica della firma fallita"

# La riga che conta: se qui compare `cdhash`, i permessi ripartiranno da zero.
REQ="$(codesign -d --requirements - "$APP" 2>&1 | grep '^designated' || true)"
case "$REQ" in
  *cdhash*) die "firma ADHOC ($REQ) — i permessi ripartirebbero da zero" ;;
  *certificate*) echo "  ✓ $REQ" ;;
  *) echo "  ⚠ requisito inatteso: $REQ" ;;
esac

echo "▸ 5/5  rilancio"
open -a "$APP"
sleep 5
PID="$(pgrep -f "$APP/Contents/MacOS/app" | head -1 || true)"
[ -n "$PID" ] || die "l'app non è ripartita — ripristina con: cp '$BACKUP' '$APP/Contents/MacOS/app'"
echo "  ✓ viva (pid $PID)"
echo
echo "Fatto. La versione del bundle resta quella del .app installato finché non"
echo "arriva una release vera: questo scambia solo il codice, non il numero."
