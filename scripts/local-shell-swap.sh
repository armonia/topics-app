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

# Si verifica FIRMANDO davvero una copia usa-e-getta, non con `find-identity -v`.
#
# PERCHE': `-v` elenca solo le identità VALIDE, e per un certificato autofirmato
# "valida" richiede che sia marcato come fidato nel portachiavi. Ma il trust
# serve a VERIFICARE una firma, non a produrla: `codesign --sign` funziona
# benissimo senza. Misurato il 2026-08-04 su questa macchina — `find-identity -v`
# non elencava "Topics Signing" mentre `codesign` firmava senza un lamento,
# producendo lo STESSO `certificate root` con cui la Topics.app installata era
# già firmata. Il vecchio controllo dava quindi un falso negativo e fermava lo
# script proprio quando tutto era a posto, spingendo verso il `--sign -` adhoc
# che questo file esiste per evitare.
#
# Il dry-run prova esattamente la proprietà che conta: so firmare, e il requisito
# che ne esce è legato al CERTIFICATO e non al cdhash di questa build.
_probe="${TMPDIR:-/tmp}/topics-sign-probe.$$"
cp /usr/bin/true "$_probe" 2>/dev/null || true
_can_sign=0
if [ -f "$_probe" ] && codesign --force --sign "$SIGN_IDENTITY" "$_probe" >/dev/null 2>&1; then
  case "$(codesign -d --requirements - "$_probe" 2>&1 | grep '^designated' || true)" in
    *cdhash*) _can_sign=0 ;;   # adhoc travestito: non basta
    *certificate*) _can_sign=1 ;;
  esac
fi
rm -f "$_probe"

if [ "$_can_sign" != 1 ]; then
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
# `touch build.rs` NON è scaramanzia. `tauri.conf.json` punta `frontendDist` a
# ../../public e `tauri_build::build()` embedda quei file nel binario, ma NIENTE
# dichiara un `rerun-if-changed` sul contenuto di public/. Cargo quindi non sa
# che il bundle è cambiato: ricompila `lib.rs` se l'hai toccato e lascia l'embed
# in cache, producendo un Mach-O nuovo con dentro una UI vecchia.
#
# Preso in flagrante il 2026-08-04: il controllo qui sotto ha fermato uno swap
# proprio così, dopo un `cargo build` da 3m30s andato a buon fine. Senza quel
# controllo l'app sarebbe partita con l'interfaccia di ieri, e il sintomo
# («le modifiche al client non si vedono») avrebbe portato a cercare una cache
# del browser che non c'entra niente.
#
# `touch build.rs` NON basta (provato, secondo giro fallito uguale): rifà girare
# build.rs ma l'artefatto con gli asset resta quello in OUT_DIR. Si pulisce il
# solo crate `app` — le dipendenze restano compilate, quindi si paga circa lo
# stesso tempo di un build incrementale del crate, non una build da zero.
"$HOME/.cargo/bin/cargo" clean -p app --release \
  --manifest-path "$REPO_ROOT/desktop-tauri/src-tauri/Cargo.toml" 2>/dev/null || true
(cd "$REPO_ROOT/desktop-tauri/src-tauri" && "$HOME/.cargo/bin/cargo" build --release)

BIN="$REPO_ROOT/desktop-tauri/src-tauri/target/release/app"
[ -f "$BIN" ] || die "binario non prodotto: $BIN"

# Il bundle appena costruito dev'essere DAVVERO dentro il binario: senza questo
# controllo si può scambiare un Mach-O che embedda una `public/` vecchia, e il
# sintomo (UI stantia) sembra un problema di cache.
ASSET="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$REPO_ROOT/public/index.html" | head -1 || true)"
# L'esito si CATTURA invece di usarlo come condizione di un pipeline.
#
# Con `set -o pipefail` (riga 33) la forma naturale — `strings … | grep -q X` —
# è rotta in modo subdolo: appena `grep -q` trova la corrispondenza esce, quindi
# `strings` riceve SIGPIPE, e il pipeline riporta l'errore di `strings` invece
# del successo di `grep`. Risultato: il controllo dichiara "bundle assente"
# ESATTAMENTE quando il bundle c'è. Costato quattro build da ~3m30s il
# 2026-08-04 prima che il sospetto cadesse sullo script invece che su cargo.
# `|| true` neutralizza l'uscita del pipeline; conta solo se l'output è vuoto.
ASSET_FOUND="$(strings "$BIN" 2>/dev/null | grep -F -m1 "$(basename "$ASSET")" || true)"
if [ -n "$ASSET" ] && [ -z "$ASSET_FOUND" ]; then
  die "il binario non contiene il bundle appena costruito ($ASSET)"
fi
echo "  ✓ bundle embeddato verificato ($ASSET)"

echo "▸ 3/5  backup + swap del Mach-O"
BACKUP="${TMPDIR:-/tmp}/topics-app-$(date +%Y%m%d-%H%M%S).bak"
cp -p "$APP/Contents/MacOS/app" "$BACKUP"
echo "  backup: $BACKUP"

# Da qui in poi l'app è CHIUSA e il binario a metà strada: qualunque errore
# successivo (o un Ctrl-C) la lascerebbe giù, e nel caso peggiore non firmata.
# Successo davvero, il 2026-08-04: lo script è morto sulla riga della firma e
# Topics è rimasta chiusa con un Mach-O senza firma — recuperata a mano.
# Il trap ripristina il backup e riapre: meglio l'app di prima che nessuna app.
_swap_done=0
_rollback() {
  local rc=$?
  trap - ERR EXIT INT TERM
  [ "$_swap_done" = 1 ] && return 0            # già arrivati in fondo
  echo "✗ interrotto (exit $rc) — ripristino il binario precedente" >&2
  cp -p "$BACKUP" "$APP/Contents/MacOS/app" 2>/dev/null || true
  codesign --remove-signature "$APP" 2>/dev/null || true
  codesign --force --deep --sign "$SIGN_IDENTITY" --identifier "$BUNDLE_ID" "$APP" 2>/dev/null || true
  open -a "$APP" 2>/dev/null || true
  echo "  Topics riaperta con la versione precedente. Backup: $BACKUP" >&2
  exit "$rc"
}
trap _rollback ERR EXIT INT TERM

if pgrep -f "$APP/Contents/MacOS/app" >/dev/null; then
  # ASK FIRST, then insist. `pkill` sends SIGTERM and the shell has no handler
  # for it, so the process dies without passing through RunEvent::ExitRequested,
  # which is where it writes the window geometry on the way out. Killing an app
  # somebody is using and reopening it somewhere else is what "Topics
  # disappeared" looked like from the outside. A quit Apple Event is the same
  # thing the user's Cmd+Q does: the app saves and exits on its own terms.
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 12); do
    pgrep -f "$APP/Contents/MacOS/app" >/dev/null || break
    sleep 0.5
  done
  # It did not go quietly (hung, or a modal is up). Now the signals.
  if pgrep -f "$APP/Contents/MacOS/app" >/dev/null; then
    echo "  la app non e' uscita da sola, passo ai segnali" >&2
    pkill -f "$APP/Contents/MacOS/app" || true
    for _ in $(seq 1 20); do
      pgrep -f "$APP/Contents/MacOS/app" >/dev/null || break
      sleep 0.5
    done
    pgrep -f "$APP/Contents/MacOS/app" >/dev/null && pkill -9 -f "$APP/Contents/MacOS/app" || true
  fi
fi

# Scrivi accanto e poi `mv`: uno swap a metà lascerebbe un .app che non parte.
cp "$BIN" "$APP/Contents/MacOS/app.new"
mv -f "$APP/Contents/MacOS/app.new" "$APP/Contents/MacOS/app"

echo "▸ 4/5  firma con «${SIGN_IDENTITY}»"
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
_swap_done=1                      # da qui il trap non deve più ripristinare
trap - ERR EXIT INT TERM
echo "  ✓ viva (pid $PID)"
echo
echo "Fatto. La versione del bundle resta quella del .app installato finché non"
echo "arriva una release vera: questo scambia solo il codice, non il numero."
