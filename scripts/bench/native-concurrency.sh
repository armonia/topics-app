#!/usr/bin/env bash
# N TURNI VERI INSIEME: quanto costa la sessione N-esima del runtime nativo.
#
# PERCHE'. Il costo di UNA sessione non dice niente sul comportamento sotto
# carico: il numero buono di un turno solo puo' non sopravvivere a trenta. Qui
# si lanciano N turni in parallelo e si misura il DELTA di memoria del server
# diviso N, piu' il tempo che ci mette l'ultimo a finire.
#
# COSTA SOLDI: N turni veri contro il modello, per ogni N della scala.
#
# IL SERVER LO SCEGLI TU, e deve essere ISOLATO. Puntarlo al server di sviluppo
# significa creare N topic veri nel database vero:
#
#   BUN_PORT=39470 DATA_DIR=/tmp/bench-conc ./scripts/start-test-server.sh &
#   scripts/bench/native-concurrency.sh --base https://127.0.0.1:39470 --scale 1,8,32
#
# Il server di prova ha `HOME` sandboxato, quindi il runtime nativo non trova le
# credenziali: copiaci dentro quelle vive prima di partire.
#
#   mkdir -p "$DATA_DIR/.home/.jcode" && cp ~/.jcode/auth.json "$DATA_DIR/.home/.jcode/"
#
# ATTENZIONE ALLA ROTAZIONE. `~/.claude/.credentials.json` con l'access token
# SCADUTO fa fare al server un refresh, e il refresh token RUOTA: il login
# `claude` dell'utente si rompe. Copia una credenziale ancora valida, o metti in
# conto di rifare `/login`.
set -uo pipefail

BASE="https://127.0.0.1:39470"
SCALE="1,2,4,8"
MODEL="claude-sonnet-4-6"
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base)  BASE="${2%/}"; shift 2;;
    --scale) SCALE="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --out)   OUT="$2"; shift 2;;
    *) echo "opzione sconosciuta: $1" >&2; exit 2;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/native-concurrency.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# IL PID LO CHIEDE AL SERVER, non lo si passa a mano: un pid sbagliato non
# fallisce, misura la memoria di un altro processo e stampa un numero credibile.
PORT="$(printf '%s' "$BASE" | sed -E 's#.*:([0-9]+).*#\1#')"
PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')"
if [ -z "${PID:-}" ]; then
  echo "nessun server in ascolto su $BASE — avvialo prima (vedi l'intestazione)" >&2
  exit 1
fi

rss_kb() { ps -o rss= -p "$1" | tr -d ' '; }

# «Ha risposto» NON e' «e' arrivato [DONE]». Un turno che fallisce l'autenticazione
# chiude lo stream regolarmente: contando i DONE, quattro turni con dentro
# «Not logged in» risultavano riusciti. Si cerca la RISPOSTA — e questo e' il
# motivo per cui il prompt chiede una cosa verificabile invece di «Rispondi OK».
PROMPT="Conta da 1 a 20, solo i numeri separati da spazio."
answered() { grep -q '20' "$1" && ! grep -q 'Not logged in' "$1"; }

echo
echo "server $BASE (pid $PID), modello $MODEL"
echo
printf '%4s  %8s  %10s  %14s\n' "N" "wall" "risposte" "per sessione"

ROWS="[]"
for N in ${SCALE//,/ }; do
  keys=()
  for i in $(seq 1 "$N"); do
    body=$(curl -sk -X POST "$BASE/api/topics" -H 'content-type: application/json' \
      -d "{\"name\":\"bench conc $N-$i-$RANDOM\"}")
    k=$(printf '%s' "$body" | python3 -c "import json,sys;print(json.load(sys.stdin)['sessionKey'])" 2>/dev/null)
    [ -n "$k" ] && keys+=("$k")
  done
  [ "${#keys[@]}" -eq 0 ] && { echo "nessun topic creato: il server risponde?" >&2; exit 1; }

  # La base si legge DOPO aver creato i topic: creare un topic costa ~0,45 MB, e
  # includerlo gonfierebbe il costo attribuito alla sessione.
  base=$(rss_kb "$PID")
  start=$(date +%s.%N)
  for k in "${keys[@]}"; do
    curl -sk -X POST "$BASE/api/chat" -H 'content-type: application/json' \
      -d "{\"sessionKey\":\"$k\",\"provider\":\"topics\",\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\"}],\"contextMode\":\"full\"}" \
      > "$WORK/${k//:/_}.txt" 2>&1 &
  done
  wait
  end=$(date +%s.%N)
  peak=$(rss_kb "$PID")

  ok=0
  for k in "${keys[@]}"; do answered "$WORK/${k//:/_}.txt" && ok=$((ok+1)); done

  read -r wall per <<<"$(awk -v s="$start" -v e="$end" -v b="$base" -v p="$peak" -v n="$N" \
    'BEGIN{printf "%.2f %.2f", e-s, (p-b)/n/1024}')"
  printf '%4d  %7ss  %6s/%-3d  %11s MB\n' "$N" "$wall" "$ok" "$N" "$per"
  ROWS=$(python3 -c "
import json,sys
rows=json.loads(sys.argv[1])
rows.append({'n':int(sys.argv[2]),'wallSeconds':float(sys.argv[3]),'answered':int(sys.argv[4]),'mbPerSession':float(sys.argv[5])})
print(json.dumps(rows))" "$ROWS" "$N" "$wall" "$ok" "$per")
done

if [ -n "$OUT" ]; then
  python3 -c "
import json,sys,datetime
json.dump({
 'schema':'bench-native-concurrency-v1',
 'measured_at':datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
 'base':sys.argv[1],'model':sys.argv[2],
 'metric':'RSS del server prima/dopo la raffica, diviso N',
 'answered_means':\"la risposta contiene '20' e non e' 'Not logged in' — [DONE] arriva anche sugli errori\",
 'runs':json.loads(sys.argv[3]),
}, open(sys.argv[4],'w'), indent=1, ensure_ascii=False)" "$BASE" "$MODEL" "$ROWS" "$OUT"
  echo
  echo "scritto $OUT"
fi
echo
