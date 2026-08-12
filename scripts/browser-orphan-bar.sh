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
  # La HOME finta isola il DB e la configurazione, ma nasconde anche la cache di
  # Playwright, che vive sotto ~/Library/Caches/ms-playwright: senza questa riga
  # il server non trova nessun Chromium e la gamba 19222 non parte nemmeno.
  export CHROMIUM_PATH="$CHROME"
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
# Solo i processi nati da QUESTA prova: tutto ciò che apriamo qui vive sotto BAR_DIR.
di_barra() { pgrep -f -- "user-data-dir=$BAR_DIR" 2>/dev/null | tr '\n' ' '; }
vivo()     { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
# IL processo browser che risponde a un pezzo di riga di comando: gli helper
# portano gli stessi switch (porta e profilo), quindi senza scartare `--type=`
# si prendono sei pid dove ne serviva uno.
browser_con() {
  for p in $(pgrep -f -- "$1" 2>/dev/null); do
    ps -o command= -p "$p" 2>/dev/null | grep -q -- "--type=" || { echo "$p"; return; }
  done
}

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
# La card chiede «pgrep -f 19222|19333 vuoto». Alla lettera è vero solo su una
# macchina dove nessun ALTRO Topics ha un browser aperto, e su quella di Attilio
# non lo è: il server di produzione tiene le sue pane sulle stesse due porte, e
# sono legittime. Quindi si prende la fotografia PRIMA e alla fine si chiede che
# su quelle porte non sia rimasto NIENTE DI NUOVO. Stessa domanda, senza
# l'ambiguità: quello che c'era prima non è roba nostra.
BASE_PORTE=" $(su_porta 19222)$(su_porta 19333)"
echo "  già su 19222/19333 prima di iniziare (non nostri):${BASE_PORTE:-  nessuno}"
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
RISPOSTA="$(curl -s -X POST "http://127.0.0.1:$PORT/api/browsers/barra01/navigate" \
  -H 'content-type: application/json' -d '{"url":"about:blank"}' 2>&1 | head -c 300)"
sleep 4
# Il marchio porta dentro il pid del padre, quindi identifica il processo senza
# ambiguità: è il pid del server di questa barra, non un altro Topics acceso.
AGENTE="$(browser_con "--topics-browser=agent:$SERVER1")"
if [ -n "$AGENTE" ]; then
  ok "chromium marchiato acceso (pid $AGENTE)"
  ps -o command= -p "$AGENTE" | tr ' ' '\n' | grep -e "--topics-browser=" -e "remote-debugging" | sed 's/^/       /'
else
  ko "nessun chromium marchiato: il marchio non arriva alla riga di comando"
  echo "     risposta di /navigate: $RISPOSTA"
fi

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
  SIDECAR="$(browser_con "--topics-browser=sidecar:$SIDECAR_PADRE")"
  ok "sidecar acceso su 19333 (pid $SIDECAR, marchio sidecar:$SIDECAR_PADRE)"
  kill -9 "$SIDECAR_PADRE" 2>/dev/null
  sleep 2
  vivo "$SIDECAR" && ok "il suo padre è morto di SIGKILL e lui è ancora lì: È IL LEAK" \
                  || ko "il sidecar è morto col padre: la prova non prova niente"
else
  SIDECAR=""
  echo "  (nessun Chromium installato per il sidecar: gamba 19333 saltata)"
  tail -3 "$BAR_DIR/sidecar.log" 2>/dev/null | sed 's/^/     /'
  kill -9 "$SIDECAR_PADRE" 2>/dev/null
fi

# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
passo "3b. il TESTIMONE: marchiato, ma con il suo padre vivo"
# Gli estranei del passo 0 provano che un Chromium senza marchio non si tocca.
# Questo prova la metà difficile: un Chromium CON il nostro marchio, il cui
# padre è ancora vivo, non si tocca lo stesso. È il caso di due Topics aperti
# insieme (produzione più un worktree), che su questa macchina è la norma: se la
# regola sbagliasse qui, ogni avvio spegnerebbe il browser dell'altro.
( esporta_ambiente; exec bun -e '
  const { createChromiumSidecar } = await import("'"$REPO_ROOT"'/server/browser-chromium-sidecar.ts");
  const s = createChromiumSidecar({ userDataDir: "'"$BAR_DIR"'/testimone-profile", port: 19666, loadExtensions: [] });
  await s.acquire();
  console.log("testimone su");
  await new Promise(() => {});
' ) >"$BAR_DIR/testimone.log" 2>&1 &
TESTIMONE_PADRE=$!
for _ in $(seq 1 40); do grep -q "testimone su" "$BAR_DIR/testimone.log" 2>/dev/null && break; sleep 1; done
TESTIMONE="$(browser_con "--topics-browser=sidecar:$TESTIMONE_PADRE")"
if [ -n "$TESTIMONE" ]; then
  ok "testimone acceso (pid $TESTIMONE, marchio sidecar:$TESTIMONE_PADRE), padre VIVO (pid $TESTIMONE_PADRE)"
else
  ko "il testimone non è partito: la prova più importante non gira"
fi

# ─────────────────────────────────────────────────────────────────────────────
passo "4. kill -9 al server"
kill -9 "$SERVER1" 2>/dev/null
sleep 3
# I due spawner NON si comportano allo stesso modo, e la barra lo deve dire
# invece di mediarlo. Playwright tiene il suo Chromium su una PIPE (stdio del
# processo): quando il server muore la pipe si chiude e il browser esce da solo,
# quindi la gamba 19222 oggi non perde niente. Il sidecar è uno `spawn` nudo con
# stdio ignorato: nessuna pipe, nessuno che gli dica di uscire, e resta lì.
if vivo "$AGENTE"; then
  ok "agente 19222 sopravvissuto (pid $AGENTE, ppid $(ps -o ppid= -p "$AGENTE" | tr -d ' ')): leak da spazzare"
else
  echo "  NOTA  agente 19222 (pid $AGENTE) è uscito da solo: Playwright lo tiene su una pipe, e la pipe muore col server"
fi
if [ -n "$SIDECAR" ]; then
  vivo "$SIDECAR" && ok "sidecar 19333 sopravvissuto (pid $SIDECAR, ppid $(ps -o ppid= -p "$SIDECAR" | tr -d ' ')): leak da spazzare" \
                  || ko "sidecar sparito: la barra non ha piu' niente da spazzare"
fi
[ -n "$(nostri)" ] || ko "nessun orfano marchiato in piedi: senza leak questa barra non misura niente"

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
vivo "$SIDECAR" && ko "il sidecar orfano (pid $SIDECAR) è ancora lì: non è stato spazzato" \
                || ok "l'orfano su 19333 è stato spazzato (pid $SIDECAR)"
vivo "$AGENTE"  && ko "l'agente (pid $AGENTE) è ancora lì" \
                || ok "niente più sull'agente 19222 (pid $AGENTE)"
NUOVI=""; ALTRUI=""
for p in $(su_porta 19222) $(su_porta 19333); do
  case "$BASE_PORTE" in *" $p "*) continue ;; esac
  # Comparso durante la prova: nostro (marchio o profilo della barra) o di
  # qualcun altro che ha aperto una pane mentre misuravamo? Solo il primo caso
  # è un fallimento; il secondo va detto, non contato.
  if ps -o command= -p "$p" 2>/dev/null | grep -q -e "--topics-browser=" -e "user-data-dir=$BAR_DIR"; then
    NUOVI="$NUOVI $p"
  else
    ALTRUI="$ALTRUI $p"
  fi
done
[ -z "$NUOVI" ] && ok "su 19222/19333 non è rimasto niente di nostro" || ko "restano nostri su 19222/19333:$NUOVI"
[ -n "$ALTRUI" ] && echo "     (nel frattempo un altro Topics ne ha aperti:$ALTRUI — non sono nostri e restano vivi)"
vivo "$ESTRANEO1" && ok "estraneo 1 ancora vivo (pid $ESTRANEO1)" || ko "estraneo 1 UCCISO"
vivo "$ESTRANEO2" && ok "estraneo 2 ancora vivo (pid $ESTRANEO2)" || ko "estraneo 2 UCCISO"
if [ -n "$TESTIMONE" ]; then
  vivo "$TESTIMONE" && ok "testimone MARCHIATO ancora vivo (pid $TESTIMONE): il padre vivo lo salva" \
                    || ko "testimone UCCISO: la spazzata mangia i browser di un altro Topics acceso"
fi

passo "pulizia"
kill -TERM "$SERVER2" 2>/dev/null
sleep 2
kill -9 "$SERVER2" "$ESTRANEO1" "$ESTRANEO2" "$TESTIMONE_PADRE" 2>/dev/null
sleep 1
pkill -f "user-data-dir=$BAR_DIR" 2>/dev/null
sleep 2
pkill -9 -f "user-data-dir=$BAR_DIR" 2>/dev/null
# I due sidecar del server (bridge delle PTY e broker AI) sono detached apposta,
# per sopravvivere a un reload: qui vanno chiusi a mano, o questa barra
# lascerebbe in giro proprio il tipo di orfano che va a spazzare. Il pattern
# contiene il socket della barra, quindi non può raggiungere quelli veri.
pkill -f "socket $BAR_DIR" 2>/dev/null
sleep 1
RESIDUI="$(pgrep -f "$BAR_DIR" 2>/dev/null | tr '\n' ' ')"
[ -z "$RESIDUI" ] && ok "niente residui" || ko "residui della barra ancora vivi: $RESIDUI"

echo
if [ "$FALLITE" -eq 0 ]; then echo "BARRA VERDE: tutte le misure sono quelle attese."; exit 0; fi
echo "BARRA ROSSA: $FALLITE misure fuori posto."; exit 1
