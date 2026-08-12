#!/usr/bin/env bash
# browser-orphan-bar.sh — la BARRA della spazzata dei Chromium orfani.
#
# Si scrive una volta e si esegue sempre uguale. Esce zero solo se TUTTE le
# misure sono quelle attese, e stampa un verbale con i pid a ogni passo, così
# un esito si può contestare invece che credere.
#
#   1. si avvia un server di prova ISOLATO (DB, HOME, socket e porta suoi);
#   2. gli si fa aprire un browser da pane -> un Chromium marchiato su 19222;
#   3. si lascia orfano anche un sidecar marchiato su 19333;
#   4. `kill -9` al server: i due Chromium DEVONO sopravvivere (è il leak);
#   5. il server riparte: al termine dell'avvio NON deve restarne nessuno;
#   6. i due Chromium ESTRANEI, accesi apposta prima, devono essere ancora vivi.
#
# ISOLAMENTO, e non è un dettaglio. Il server vero di questa macchina ospita le
# sessioni Claude e il bridge delle PTY: un `kill -9` lì dentro le porterebbe
# giù con sé. Questa barra non lo tocca. Ogni variabile qui sotto esiste perché
# il processo di prova non condivida NIENTE con quello di produzione: né il
# database, né la HOME, né i due socket dei sidecar.
#
# Uso: bash scripts/browser-orphan-bar.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BAR_DIR="${BAR_DIR:-/tmp/topics-browser-bar}"
PORT="${BAR_PORT:-13999}"
LOG="$BAR_DIR/server.log"
FALLITE=0

rm -rf "$BAR_DIR"
mkdir -p "$BAR_DIR/home" "$BAR_DIR/openclaw" "$BAR_DIR/topics-home"

esporta_ambiente() {
  export BUN_PORT="$PORT"
  export DATA_DIR="$BAR_DIR/data"
  export TOPICS_HOME="$BAR_DIR/topics-home"
  export OPENCLAW_DIR="$BAR_DIR/openclaw"
  export HOME="$BAR_DIR/home"
  export TOPICS_PTY_SOCKET="$BAR_DIR/pty.sock"
  export TOPICS_AI_BRIDGE_SOCKET="$BAR_DIR/ai-bridge.sock"
  export SERVER_HOST=127.0.0.1
  export GATEWAY_TOKEN="${GATEWAY_TOKEN:-bar-token}"
  export GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"
}

ok()   { echo "  OK   $*"; }
ko()   { echo "  ROTTO $*"; FALLITE=$((FALLITE + 1)); }
passo(){ echo; echo "── $* ──"; }

# I NOSTRI: solo chi porta il marchio. È la definizione che il codice usa.
nostri()   { pgrep -f -- "--topics-browser=" 2>/dev/null | tr '\n' ' '; }
# Le due porte della barra, che è come la domanda è scritta sulla card.
su_porta() { pgrep -f -- "--remote-debugging-port=$1" 2>/dev/null | tr '\n' ' '; }
vivo()     { kill -0 "$1" 2>/dev/null; }

CHROME="$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app/Contents/MacOS/* 2>/dev/null | head -1)"
[ -z "$CHROME" ] && CHROME="$(ls -d /Users/*/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app/Contents/MacOS/* 2>/dev/null | head -1)"
if [ -z "$CHROME" ]; then echo "Nessun Chromium di Playwright trovato: barra non eseguibile."; exit 2; fi
echo "chromium: $CHROME"

# ─────────────────────────────────────────────────────────────────────────────
passo "0. gli ESTRANEI, accesi prima di tutto"
# Due testimoni. Il primo è un Chromium qualunque. Il secondo è la copia esatta
# della riga di comando che usiamo noi, marchio a parte: se la spazzata lo
# uccidesse, vorrebbe dire che sta guardando la forma e non il marchio.
"$CHROME" --headless=new --remote-debugging-port=19444 \
  --user-data-dir="$BAR_DIR/estraneo-1" --no-first-run >/dev/null 2>&1 &
ESTRANEO1=$!
"$CHROME" --headless=new --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage \
  --remote-debugging-port=19555 --user-data-dir="$BAR_DIR/estraneo-2" >/dev/null 2>&1 &
ESTRANEO2=$!
sleep 3
vivo "$ESTRANEO1" && ok "estraneo 1 acceso (pid $ESTRANEO1)" || ko "estraneo 1 non è partito"
vivo "$ESTRANEO2" && ok "estraneo 2 acceso, riga identica alla nostra senza marchio (pid $ESTRANEO2)" || ko "estraneo 2 non è partito"

# ─────────────────────────────────────────────────────────────────────────────
passo "1. il server di prova, isolato"
if [ -n "$(su_porta 19222)$(su_porta 19333)" ]; then
  echo "  ATTENZIONE: qualcuno tiene già 19222/19333. La misura sarebbe ambigua."
  echo "  pid: $(su_porta 19222)$(su_porta 19333)"
  ko "porte occupate prima di iniziare"
fi
( esporta_ambiente; exec bun run "$REPO_ROOT/server.ts" ) >"$LOG" 2>&1 &
SERVER1=$!
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/browser/status" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/browser/status" >/dev/null 2>&1 \
  && ok "server su (pid $SERVER1, porta $PORT)" || { ko "il server non risponde"; tail -20 "$LOG"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
passo "2. un browser aperto dal pane"
curl -sf -X POST "http://127.0.0.1:$PORT/api/browsers/barra01/navigate" \
  -H 'content-type: application/json' -d '{"url":"about:blank"}' >/dev/null 2>&1
sleep 4
NOSTRI_VIVI="$(nostri)"
[ -n "$NOSTRI_VIVI" ] && ok "chromium marchiato acceso: $NOSTRI_VIVI" || ko "nessun chromium marchiato: il marchio non arriva alla riga di comando"
[ -n "$(su_porta 19222)" ] && ok "e risponde alla domanda della card: pgrep 19222 = $(su_porta 19222)" || ko "niente su 19222"

# ─────────────────────────────────────────────────────────────────────────────
passo "3. un sidecar orfano su 19333"
# Lo apre un processo a parte che poi muore di SIGKILL: è esattamente la
# condizione che il marchio deve saper riconoscere (padre morto, browser vivo).
( esporta_ambiente; exec bun -e '
  const { createChromiumSidecar } = await import("'"$REPO_ROOT"'/server/browser-chromium-sidecar.ts");
  const s = createChromiumSidecar({ userDataDir: "'"$BAR_DIR"'/sidecar-profile", port: 19333, loadExtensions: [] });
  await s.acquire();
  console.log("sidecar su");
  await new Promise(() => {});
' ) >"$BAR_DIR/sidecar.log" 2>&1 &
SIDECAR_PADRE=$!
for _ in $(seq 1 40); do grep -q "sidecar su" "$BAR_DIR/sidecar.log" 2>/dev/null && break; sleep 1; done
if grep -q "sidecar su" "$BAR_DIR/sidecar.log" 2>/dev/null; then
  ok "sidecar acceso su 19333: $(su_porta 19333)"
  kill -9 "$SIDECAR_PADRE" 2>/dev/null
  sleep 2
  [ -n "$(su_porta 19333)" ] && ok "il suo padre è morto e lui è ancora lì (il leak): $(su_porta 19333)" \
                             || ko "il sidecar è morto col padre: la prova non prova niente"
else
  echo "  (nessun Chromium installato per il sidecar: gamba 19333 saltata)"
  tail -3 "$BAR_DIR/sidecar.log" 2>/dev/null | sed 's/^/     /'
  kill -9 "$SIDECAR_PADRE" 2>/dev/null
fi

# ─────────────────────────────────────────────────────────────────────────────
passo "4. kill -9 al server"
PRIMA="$(nostri)"
kill -9 "$SERVER1" 2>/dev/null
sleep 3
DOPO_KILL="$(nostri)"
if [ -n "$DOPO_KILL" ]; then
  ok "i chromium sono sopravvissuti al server, come previsto: $DOPO_KILL"
  for p in $DOPO_KILL; do echo "     pid $p ppid $(ps -o ppid= -p "$p" | tr -d ' ')"; done
else
  ko "sono morti da soli: senza il leak la barra non misura niente ($PRIMA -> vuoto)"
fi

# ─────────────────────────────────────────────────────────────────────────────
passo "5. il server riparte"
( esporta_ambiente; exec bun run "$REPO_ROOT/server.ts" ) >"$BAR_DIR/server2.log" 2>&1 &
SERVER2=$!
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/browser/status" >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
grep -h "browser-sweep" "$BAR_DIR/server2.log" | sed 's/^/     /'

passo "6. l'ESITO"
RIMASTI="$(nostri)"
[ -z "$RIMASTI" ] && ok "nessun chromium col nostro marchio" || ko "ne restano: $RIMASTI"
P19222="$(su_porta 19222)"; P19333="$(su_porta 19333)"
[ -z "$P19222" ] && ok "pgrep -f 19222 vuoto" || ko "19222: $P19222"
[ -z "$P19333" ] && ok "pgrep -f 19333 vuoto" || ko "19333: $P19333"
vivo "$ESTRANEO1" && ok "estraneo 1 ancora vivo (pid $ESTRANEO1)" || ko "estraneo 1 UCCISO"
vivo "$ESTRANEO2" && ok "estraneo 2 ancora vivo (pid $ESTRANEO2)" || ko "estraneo 2 UCCISO"

passo "pulizia"
kill -TERM "$SERVER2" 2>/dev/null
sleep 2
kill -9 "$SERVER2" "$ESTRANEO1" "$ESTRANEO2" 2>/dev/null
sleep 1
pkill -f "user-data-dir=$BAR_DIR" 2>/dev/null
echo "  fatto"

echo
if [ "$FALLITE" -eq 0 ]; then echo "BARRA VERDE: tutte le misure sono quelle attese."; exit 0; fi
echo "BARRA ROSSA: $FALLITE misure fuori posto."; exit 1
