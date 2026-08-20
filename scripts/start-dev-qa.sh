#!/usr/bin/env bash
# start-dev-qa.sh - un'istanza di SVILUPPO LOCALE, isolata e persistente.
#
# A cosa serve, e perche' non basta quello che c'era gia'.
#
#   · Il server di PRODUZIONE (:3333, launchd) tiene i dati veri dell'utente e
#     le sue sessioni vive. Guidarlo per provare un edge case significa rompere
#     la giornata di qualcuno.
#   · Il server di TEST (`start-test-server.sh`, :13334) e' pensato per una
#     passata di Playwright: nasce e muore col globalSetup, e la suite gli
#     azzera il database sotto i piedi.
#
# Questo e' il terzo caso: un'istanza che si puo' MARTELLARE. Dati propri che
# restano fra una prova e l'altra, porta propria, casa propria, socket propri,
# e nessun modo di toccare la produzione. Consuma token veri quando ci si
# lancia un turno dentro, ed e' esattamente cio' che si vuole: e' l'unico modo
# di provare la chat come la vive un utente.
#
# Uso:
#   ./scripts/start-dev-qa.sh              avvia in primo piano (Ctrl-C ferma)
#   DEVQA_PORT=13401 ./scripts/start-dev-qa.sh   una seconda istanza
#   DEVQA_RESET=1 ./scripts/start-dev-qa.sh      riparte da un database vuoto
#
# L'isolamento e' lo stesso di `start-test-server.sh`, con tre differenze che
# contano:
#   1. DATA_DIR sta sotto $HOME, non /tmp: /tmp viene spazzato e due run che
#      condividono un percorso fisso si distruggono a vicenda.
#   2. TOPICS_E2E resta ARMATO, perche' `/api/test/reset` su un database
#      isolato e' comodo e non puo' fare danni.
#   3. Il bundle servito e' `public/` di QUESTO albero. In un worktree pinnato
#      nessuno lo riscrive mentre lo si guarda.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

export BUN_PORT="${DEVQA_PORT:-13400}"
DEVQA_ROOT="${DEVQA_ROOT:-$HOME/.topics-devqa/$BUN_PORT}"
export DATA_DIR="$DEVQA_ROOT/data"
export TOPICS_HOME="$DEVQA_ROOT/.topics-home"
export OPENCLAW_DIR="$DEVQA_ROOT/.openclaw"
export TOPICS_PTY_SOCKET="$DEVQA_ROOT/pty-bridge.sock"
export TOPICS_AI_BRIDGE_SOCKET="$DEVQA_ROOT/ai-bridge.sock"
export TOPICS_E2E=1
# SOLO loopback. Il default del server e' `::` (server.ts:2348), cioe' tutte le
# interfacce: e' la scelta giusta per la produzione, che deve essere
# raggiungibile dal telefono in LAN. Qui no. Questa istanza ha `/api/test/reset`
# armato, che svuota ogni tabella senza chiedere niente a nessuno, e non c'e'
# nessun motivo per cui debba essere raggiungibile dal wifi di casa.
export SERVER_HOST="${SERVER_HOST:-127.0.0.1}"
# Il relay OpenClaw resta SPENTO se non lo si chiede. Con un token finto il
# server trova qualcosa in ascolto sulla porta di default, fallisce la stretta
# di mano e riprova in loop: rumore puro nel log di una istanza che quel canale
# non lo usa. Per provarlo davvero: GATEWAY_TOKEN=... GATEWAY_URL=... .
if [ -n "${GATEWAY_TOKEN:-}" ]; then
  export GATEWAY_TOKEN GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"
else
  unset GATEWAY_TOKEN GATEWAY_URL 2>/dev/null || true
fi
# Nessun tunnel, nessun relay: questa istanza non esce dalla macchina.
unset TOPICS_TUNNEL_PORT TOPICS_RELAY_URL 2>/dev/null || true

if [ "${DEVQA_RESET:-0}" = "1" ]; then
  echo "[dev-qa] azzero $DEVQA_ROOT"
  rm -rf "$DEVQA_ROOT"
fi

mkdir -p "$DATA_DIR" "$TOPICS_HOME" "$OPENCLAW_DIR"

if [ ! -f "$REPO_ROOT/public/index.html" ]; then
  echo "[dev-qa] manca public/index.html. Costruiscilo: cd client && bun run build" >&2
  exit 1
fi

echo "[dev-qa] porta      : $BUN_PORT"
echo "[dev-qa] dati       : $DATA_DIR"
echo "[dev-qa] casa       : $TOPICS_HOME"
echo "[dev-qa] bundle     : $REPO_ROOT/public ($(date -r "$REPO_ROOT/public/index.html" '+%d/%m %H:%M'))"
echo "[dev-qa] produzione : NON toccata (:3333 resta sua)"

exec bun run server.ts
