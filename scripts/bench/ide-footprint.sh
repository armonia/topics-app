#!/usr/bin/env bash
# QUANTO COSTA IL SECONDO PROGETTO — Cursor, VS Code, e chiunque altro.
#
# PERCHE'. Un IDE ti da' un progetto per FINESTRA. La domanda che divide i
# prodotti non e' «quanto pesa da fermo», e' «quanto pesa il progetto in piu'»:
# la prima e' una fotografia, la seconda e' la pendenza su cui vivi tutto il
# giorno. Questo script misura la pendenza, aprendo gli STESSI repo nello
# stesso ordine in ogni app.
#
# LA METRICA. `phys_footprint` sommato su TUTTI i processi dell'app — la colonna
# «Memoria» di Monitoraggio Attivita'. Un IDE moderno e' quindici processi: RSS
# li conterebbe male (le pagine condivise una volta per processo) e guardare il
# solo padre direbbe un terzo del vero.
#
# ONESTA'. Non e' un confronto di FUNZIONALITA'. Un IDE con un progetto aperto
# fa cose che Topics non fa (language server, indicizzazione, analisi dei tipi).
# Qui si misura una cosa sola, quella su cui i prodotti sono in disaccordo.
#
# USAGE
#   scripts/bench/ide-footprint.sh ~/Projects/a ~/Projects/b ~/Projects/c
#   scripts/bench/ide-footprint.sh --apps "Cursor,Zed" ~/p1 ~/p2
set -uo pipefail

APPS="Cursor,Visual Studio Code"
SETTLE=50
PROJECTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apps)   APPS="$2"; shift 2;;
    --settle) SETTLE="$2"; shift 2;;
    -h|--help) sed -n '2,24p' "$0"; exit 0;;
    *) PROJECTS+=("$1"); shift;;
  esac
done

if [ "${#PROJECTS[@]}" -lt 2 ]; then
  echo "servono almeno due progetti: la pendenza e' una differenza." >&2
  echo "  scripts/bench/ide-footprint.sh ~/Projects/a ~/Projects/b ~/Projects/c" >&2
  exit 2
fi

# Footprint totale di un'app, in MB. `vmmap` parla in K/M/G: si normalizza qui,
# perche' sommare "1.2G" e "340M" come numeri darebbe 341.
#
# QUALI PROCESSI SONO DELL'APP: due trappole opposte, entrambe pagate.
#
# `pgrep -f "Visual Studio Code"` pesca anche i processi di CURSOR, che e' un
# fork di VS Code e ha «Code» nei suoi path: il conto dava 1368 MB per un VS
# Code chiuso.
#
# Ma filtrare sul solo path del bundle sbaglia al contrario: gli helper si
# RINOMINANO («Cursor Helper: shared-process») e perdono il path, quindi ne
# sparivano sei su tredici e il totale usciva quasi dimezzato — 1889 MB contro
# i 3434 misurati a mano sugli stessi tre progetti.
#
# Si prende l'unione: chi ha il path del bundle, PIU' chi si chiama «<App>
# Helper», che e' la convenzione di ogni app Electron/Chromium. `sort -u`
# perche' un processo che soddisfa entrambi i criteri va contato una volta.
footprint_mb() {
  local app="$1" bundle="/Applications/$1.app" pids tot=0 n=0 f v
  pids=$( { pgrep -f "^$bundle/" 2>/dev/null; pgrep -f "^$app Helper" 2>/dev/null; } | sort -un | tr '\n' ' ')
  [ -z "$pids" ] && { echo "0 0"; return; }
  for p in $pids; do
    f=$(vmmap --summary "$p" 2>/dev/null | awk '/^Physical footprint:/{print $3}')
    case "$f" in
      *G) v=$(echo "${f%G} * 1024" | bc);;
      *M) v=${f%M};;
      *K) v=$(echo "scale=3; ${f%K} / 1024" | bc);;
      *)  v=0;;
    esac
    tot=$(echo "$tot + $v" | bc); n=$((n+1))
  done
  printf "%.0f %d\n" "$tot" "$n"
}

echo
echo "Footprint per numero di progetti aperti — $(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null), $(sysctl -n hw.ncpu) core, $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
echo "Attesa di ${SETTLE}s dopo ogni apertura, perche' l'indicizzazione parte all'apertura e finisce dopo."
echo

IFS=',' read -ra APP_LIST <<< "$APPS"
for app in "${APP_LIST[@]}"; do
  [ -d "/Applications/$app.app" ] || { echo "$app: non installata, salto"; continue; }

  # Si parte da spenta: un'app gia' aperta su altri progetti falserebbe la base.
  osascript -e "tell application \"$app\" to quit" >/dev/null 2>&1
  sleep 6

  printf "%-22s" "$app"
  prev=0
  for i in "${!PROJECTS[@]}"; do
    open -a "$app" "${PROJECTS[$i]}" 2>/dev/null || { echo " (apertura fallita)"; break; }
    sleep "$SETTLE"
    read -r mb procs <<< "$(footprint_mb "$app")"
    if [ "$i" -eq 0 ]; then printf "%6s MB" "$mb"; else printf " %6s MB" "$mb"; fi
    prev=$mb
  done

  echo "   ($procs processi)"

  osascript -e "tell application \"$app\" to quit" >/dev/null 2>&1
  sleep 4
done

echo
echo "La pendenza e' la differenza fra due colonne adiacenti: e' quella che dice"
echo "cosa costa il progetto in piu'. Per Topics il confronto sta in bench/README.md:"
echo "un progetto e' una riga nel database, non una finestra."
echo
