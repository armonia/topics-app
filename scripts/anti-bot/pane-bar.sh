#!/usr/bin/env bash
# Barra anti-bot della pane di Topics (WKWebView figlio, fuori schermo, mai in
# primo piano). Misura sul motore vero, con la sonda tools/wkzprobe:
#
#   1. console.hetzner.com arriva alla pagina di login di accounts.hetzner.com
#      (non resta su /_ray/pow) in meno di 60 s, N volte su N (default 3),
#      distanziate di GAP secondi: il blocco «Request on Hold» di Heray cresce
#      con i tentativi ravvicinati, quindi niente raffiche.
#   2. bot.sannysoft.com: quante righe falliscono (misura, non gate).
#   3. una pagina Cloudflare con sfida (demo di scrapingcourse.com, fatta per
#      questo): la sfida passa? (misura, non gate).
#
# uso: scripts/anti-bot/pane-bar.sh [--prima] [--runs N] [--gap S] [--solo-misure]
#   --prima         lancia SENZA lo script di correzione: riproduce il difetto
#   --solo-misure   salta Hetzner (sannysoft e Cloudflare soltanto)
# Esce 0 se Hetzner passa N su N sotto i 60 s, 1 se no.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_DIR="$ROOT/tools/wkzprobe"
PROBE="$PROBE_DIR/target/release/wkzprobe"
INIT="$ROOT/desktop-tauri/src-tauri/src/pane_window_metrics.js"
RUNS=3; GAP=150; PRIMA=0; SOLO_MISURE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prima) PRIMA=1 ;;
    --runs) RUNS="$2"; shift ;;
    --gap) GAP="$2"; shift ;;
    --solo-misure) SOLO_MISURE=1 ;;
    *) echo "argomento sconosciuto: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(uname)" = "Darwin" ] || { echo "la barra misura il WKWebView: solo macOS" >&2; exit 2; }
[ -x "$PROBE" ] || cargo build --release --manifest-path "$PROBE_DIR/Cargo.toml" >&2 || exit 2
FIX=("$INIT"); [ "$PRIMA" = 1 ] && FIX=()
echo "modo: $([ "$PRIMA" = 1 ] && echo 'PRIMA (senza correzione)' || echo 'DOPO (con pane_window_metrics.js)')"

fail=0
if [ "$SOLO_MISURE" = 0 ]; then
  for i in $(seq 1 "$RUNS"); do
    out=$(timeout 100 "$PROBE" antibot https://console.hetzner.com/projects https://accounts.hetzner.com/login ${FIX[@]+"${FIX[@]}"} 2>&1 | /usr/bin/grep '^RESULT' | tail -1)
    secs=$(echo "$out" | sed -n 's/.*secs=\([0-9.]*\).*/\1/p')
    if echo "$out" | /usr/bin/grep -q '^RESULT pass' && awk "BEGIN{exit !($secs < 60)}"; then
      echo "hetzner $i/$RUNS: PASSA in ${secs}s (login raggiunto)"
    else
      echo "hetzner $i/$RUNS: NON PASSA  ${out:-nessun risultato}"; fail=1
    fi
    [ "$i" -lt "$RUNS" ] && sleep "$GAP"
  done
fi

SANNY_JS='JSON.stringify({failed:[...document.querySelectorAll("td.failed")].map(td=>(td.previousElementSibling||td).innerText.trim()),passed:document.querySelectorAll("td.passed").length})'
out=$(WKZ_WAIT=10 WKZ_EVAL="$SANNY_JS" timeout 60 "$PROBE" antibot https://bot.sannysoft.com - ${FIX[@]+"${FIX[@]}"} 2>&1 | /usr/bin/grep '^RESULT' | tail -1)
echo "sannysoft: ${out:-nessun risultato}"

CF_JS='document.title+" | "+document.body.innerText.slice(0,120).replace(/\n/g," ")'
out=$(WKZ_WAIT=25 WKZ_EVAL="$CF_JS" timeout 80 "$PROBE" antibot https://www.scrapingcourse.com/cloudflare-challenge - ${FIX[@]+"${FIX[@]}"} 2>&1 | /usr/bin/grep '^RESULT' | tail -1)
if echo "$out" | /usr/bin/grep -qi 'bypassed'; then echo "cloudflare: SFIDA PASSATA  $out"; else echo "cloudflare: sfida NON passata  ${out:-nessun risultato}"; fi

if [ "$SOLO_MISURE" = 1 ]; then exit 0; fi
[ "$fail" = 0 ] && echo "BARRA: VERDE (hetzner $RUNS/$RUNS)" || echo "BARRA: ROSSA"
exit "$fail"
