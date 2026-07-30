#!/usr/bin/env bash
# e2e-shards.sh — la suite E2E in N processi paralleli, sulla stessa macchina.
#
# Playwright gira con `workers: 1` e `fullyParallel: false` (playwright.config.ts)
# perché i test condividono UN server e UN SQLite: dentro un singolo processo la
# serialità è l'unica cosa che li tiene onesti. La suite intera è ~500 test, e
# in serie sono ~35 minuti di attesa.
#
# Il parallelismo giusto quindi non è "più worker", è PIÙ SUITE: N processi
# Playwright, ognuno con il SUO server, il SUO database e i SUOI socket. È
# esattamente ciò che fa il nightly su CI (`--shard=i/4`), dove ogni shard ha un
# runner tutto suo; in locale mancava solo che porta e percorsi smettessero di
# essere cablati — ora arrivano da E2E_PORT (tests/e2e/helpers/test-server.ts).
#
# Uso:
#   ./scripts/e2e-shards.sh                    # 4 shard, tutta la suite
#   SHARDS=2 ./scripts/e2e-shards.sh           # 2 shard
#   ./scripts/e2e-shards.sh --grep @smoke      # gli argomenti passano a playwright
#   E2E_TIER=pr ./scripts/e2e-shards.sh        # solo il gate PR
#   STAGGER=0 ./scripts/e2e-shards.sh          # avvii simultanei (vedi sotto)
#
# Gli avvii sono SFASATI di STAGGER secondi. Partendo tutti insieme, N shard
# fanno insieme anche la parte più costosa del boot — 69 migrazioni su un SQLite
# nuovo, il BrowserService, il PTY-bridge — e su una macchina sola si fanno la
# fila a vicenda: il 30/07, con 4 shard, uno ha sforato il timeout di avvio del
# server e un altro ha perso una corsa sulla cache di trasformazione dei moduli
# (`Cannot read properties of undefined (reading 'Symbol(testType)')`). Nessuno
# dei due era un bug del codice: ripetuti da soli, verdi. Sfasare costa qualche
# secondo su un run di minuti ed è la differenza fra una suite che si può
# credere e una che va ricontrollata a mano ogni volta.
#
# Ogni shard scrive log e risultati sotto test-results/shard-<i>/; alla fine
# stampa UN riepilogo con tutti i falliti di tutti gli shard. Uno shard che non
# arriva a eseguire test è un FALLIMENTO del riepilogo, non una nota a piè di
# pagina: vedi scripts/e2e-shards-summary.ts.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SHARDS="${SHARDS:-4}"
# La porta di partenza segue la stessa regola del default di `E2E_PORT`
# (tests/e2e/helpers/worktree-port.ts): 13334 dal checkout principale, una porta
# derivata dal path se questo è un worktree di dispatch. Cablare 13334 qui
# significherebbe che lo shard 0 di un agente si riprende esattamente la porta
# che il resto del fix tiene libera — e il suo global-setup ammazzerebbe il
# server della run vera.
BASE_PORT="${E2E_BASE_PORT:-$(bun -e 'import {defaultE2EPort} from "./tests/e2e/helpers/worktree-port"; import {homedir} from "os"; console.log(defaultE2EPort(process.cwd(), homedir()))' 2>/dev/null)}"
STAGGER="${STAGGER:-5}"

if ! [[ "$SHARDS" =~ ^[0-9]+$ ]] || [ "$SHARDS" -lt 1 ]; then
  echo "SHARDS deve essere un intero >= 1 (ricevuto: $SHARDS)" >&2
  exit 2
fi
# Una derivazione fallita non deve degradare in silenzio su una porta a caso (o
# vuota): meglio fermarsi e dirlo.
if ! [[ "$BASE_PORT" =~ ^[0-9]+$ ]] || [ "$BASE_PORT" -lt 1024 ]; then
  echo "BASE_PORT non valida (ricevuto: '${BASE_PORT}'). Passa E2E_BASE_PORT=<porta> a mano." >&2
  exit 2
fi
if ! [[ "$STAGGER" =~ ^[0-9]+$ ]]; then
  echo "STAGGER deve essere un intero >= 0 (ricevuto: $STAGGER)" >&2
  exit 2
fi

# Il tetto d'attesa per l'apertura della porta del server di test. Il ciclo esce
# appena la porta risponde, quindi un tetto alto non costa nulla quando il server
# è pronto in fretta: costa solo quanto si aspetta prima di sapere che è morto.
# I 30s di default bastavano a uno shard solo e non a quattro.
export E2E_SERVER_START_TIMEOUT_MS="${E2E_SERVER_START_TIMEOUT_MS:-90000}"

pids=()
ports=()

cleanup() {
  echo ""
  echo "[e2e-shards] interrotto — chiudo gli shard…"
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  # I server di test muoiono col globalTeardown di ciascuno shard; se lo shard
  # è stato ucciso prima, la porta resta occupata — liberala qui.
  for port in "${ports[@]:-}"; do
    lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
  done
  exit 130
}
trap cleanup INT TERM

echo "[e2e-shards] $SHARDS shard paralleli, porte $BASE_PORT..$((BASE_PORT + SHARDS - 1)) (avvii sfasati di ${STAGGER}s)"

for i in $(seq 1 "$SHARDS"); do
  port=$((BASE_PORT + i - 1))
  out="test-results/shard-$i"
  rm -rf "$out"
  mkdir -p "$out"

  # --reporter da CLI SOSTITUISCE quelli del config: niente html (gli shard si
  # sovrascriverebbero a vicenda la stessa cartella), un JSON per shard che il
  # riepilogo finale rilegge.
  E2E_PORT="$port" \
  PLAYWRIGHT_JSON_OUTPUT_NAME="$out/results.json" \
    npx playwright test \
      --shard="$i/$SHARDS" \
      --reporter=line,json \
      --output="$out/artifacts" \
      "$@" >"$out/log.txt" 2>&1 &

  pids+=("$!")
  ports+=("$port")
  echo "[e2e-shards]   shard $i/$SHARDS → :$port  (pid $!, log $out/log.txt)"

  # Sfasa il prossimo avvio: è il boot del server (migrazioni + BrowserService)
  # a fare la fila, non i test.
  if [ "$i" -lt "$SHARDS" ] && [ "$STAGGER" -gt 0 ]; then
    sleep "$STAGGER"
  fi
done

failed_shards=0
for idx in "${!pids[@]}"; do
  if ! wait "${pids[$idx]}"; then
    failed_shards=$((failed_shards + 1))
  fi
  echo "[e2e-shards] shard $((idx + 1)) finito"
done

echo ""
bun run "$REPO_ROOT/scripts/e2e-shards-summary.ts" "$SHARDS"
summary_status=$?

# L'esito è quello dei test, non dei processi: uno shard può uscire non-zero
# anche solo per il teardown, e i falliti veri li conta il riepilogo.
if [ "$summary_status" -ne 0 ]; then
  exit "$summary_status"
fi
if [ "$failed_shards" -ne 0 ]; then
  echo "[e2e-shards] nessun test fallito, ma $failed_shards shard sono usciti non-zero: controlla i log."
  exit 1
fi
exit 0
