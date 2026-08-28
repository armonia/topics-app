#!/bin/bash
# Start prod server with auto-reload for both server and client
#
# ─── DOPO AVER MODIFICATO QUESTO FILE, RIAVVIA IL SUPERVISORE ──────────────
#
#     launchctl kickstart -k gui/$(id -u)/com.armonia.topics-server
#
# Non e' una raccomandazione di stile: bash legge uno script IN ESECUZIONE a
# OFFSET DI BYTE, non tutto in memoria. Inserire righe in mezzo a un file che
# sta girando sposta tutto cio' che viene dopo, e al prossimo comando che il
# processo va a rileggere puo' ritrovarsi a meta' di un'altra istruzione. Lo
# script vivo qui e' il supervisore di TUTTO — se si confonde, non riparte piu'
# niente.
#
# C'e' anche la ragione banale, che vale lo stesso: finche' non lo riavvii, la
# modifica non ha effetto. Il 20/08 questo processo era vivo da un giorno
# intero, quindi girava ancora la versione precedente di ogni riga qui sotto.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# ─── PATH hardening (2026-06-07) ───────────────────────────────────────────
# launchd hands this job a minimal PATH that does NOT include ~/.bun/bin, so the
# `bun --watch` invocation below failed with "bun: command not found" the moment
# the job was restarted — the server never came back up, and (because the PTY
# bridge is a child of the server) its parent-death watchdog then took the live
# Claude PTYs down with it. The old long-lived process only survived because it
# had been started under an interactive shell PATH that the plist no longer
# reproduces. Resolve bun (+ Homebrew/local) explicitly so a restart is always
# self-sufficient, regardless of the launchd environment.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

# ─── Descrittori di file (2026-08-19) ──────────────────────────────────────
# launchd consegna a questo job il default di sistema: `maxfiles 256`. Una
# shell interattiva ne ha 1.048.576, quindi il server misurato a mano sembra
# sano e sotto launchd non lo e'.
#
# 256 non basta a questo processo nemmeno da fermo: tiene una WebSocket per
# ogni client aperto, un socket unix per ogni figlio (pty-bridge, ai-bridge,
# un server MCP per agente dispacciato), e le connessioni verso l'API. Con
# dieci agenti al lavoro sono gia' un centinaio prima di servire una pagina.
#
# COSA SUCCEDE QUANDO FINISCONO, ed e' il motivo per cui questa riga esiste:
# il processo NON muore e non scrive niente in log. Continua a lavorare sulle
# connessioni che ha gia' — gli agenti proseguono, il DB si aggiorna — ma ogni
# connessione NUOVA viene accettata e chiusa subito dopo l'handshake TLS. Dal
# di fuori e' un server vivo che non risponde: il client non riesce a
# riconnettersi e l'interfaccia resta ferma sull'ultimo stato che aveva, che e'
# esattamente il sintomo «devo aggiornare l'app per vedere lo stato giusto».
#
# Misurato il 19/08/2026 sul server di produzione: 287 descrittori aperti
# contro un tetto di 256, di cui 133 socket in stato CLOSED e 22 in CLOSE_WAIT
# — cioe' connessioni gia' finite che tenevano ancora il posto. Il conto
# cresceva di 4 ogni 45 secondi (~320/ora), quindi il blackout arrivava in meno
# di un'ora dall'avvio.
#
# Questo alza il TETTO, non ferma la perdita: il socket che resta appeso a una
# richiesta abortita e' un difetto suo, e ha la sua card. Ma senza questa riga
# la perdita diventa un'interruzione di servizio invece di un numero da
# guardare.
ulimit -n 65536 2>/dev/null || ulimit -n 10240 2>/dev/null || true
echo "[start-prod] descrittori disponibili: $(ulimit -n)"

# ─── Optional LOCAL env overrides (per-machine, NOT committed) ──────────────
# A developer's own machine can enable experimental server flags (e.g.
# TOPICS_AI_BRIDGE=1 to run the detached AI broker) by dropping `export FOO=bar`
# lines in ~/.topics-server-env. The file never exists on a downloaded/other
# install, so released builds stay clean — this line is a harmless no-op there.
[ -f "$HOME/.topics-server-env" ] && source "$HOME/.topics-server-env"

# ─── Single-instance guard (2026-05-11) ────────────────────────────────────
# Without this, every `launchctl bootout`/`bootstrap` cycle (or any glitchy
# `KeepAlive=true` restart) leaves a SECOND `start-prod.sh` running in
# parallel. Each instance spawns its own fswatch + bun --watch, so every
# real change fires N builds — AND fswatch can emit phantom events at a
# steady cadence (~10 s in our case), which manifested as "the app
# refreshes by itself every 10 seconds". Holding a PID lockfile keeps
# exactly one instance alive.
LOCKFILE="/tmp/topics-start-prod.lock"
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "$$" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[start-prod] Another instance is already running (PID $OLD_PID). Exiting."
    exit 0
  fi
  # Stale lockfile — clean up
  rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"

# Atomic-write check: only proceed if we won the race
sleep 0.2
WINNER=$(cat "$LOCKFILE" 2>/dev/null)
if [ "$WINNER" != "$$" ]; then
  echo "[start-prod] Lost race to PID $WINNER. Exiting."
  exit 0
fi

# Clean up the lockfile + any child processes on exit so a future restart
# isn't blocked by a stale PID. SIGTERM from launchd (`bootout`) lands here.
SERVER_PIDFILE="/tmp/topics-server.pid"
# Set by cleanup so the restart-on-exit loop below STOPS relaunching on a real
# shutdown. Without this the loop would resurrect the server after teardown,
# making the script unkillable by SIGTERM (only SIGKILL would stop it — which
# bypasses server.ts gracefulShutdown and orphans the PTY bridge + claude
# children, the exact failure this script set out to avoid).
SHUTTING_DOWN=0
cleanup() {
  # Drop the traps FIRST so the `exit` below doesn't re-enter cleanup through
  # the EXIT trap, and flag the loop to stop.
  trap - EXIT INT TERM
  SHUTTING_DOWN=1
  rm -f "$LOCKFILE" "$SERVER_PIDFILE"
  # SIGTERM the server child so server.ts gracefulShutdown runs (clean bridge
  # disconnect) rather than the child being orphaned.
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null
  # Kill our background watchers. NOTE: killing a watcher subshell does NOT reap
  # its `fswatch` grandchild, so we also pkill those by pattern.
  jobs -p | xargs -r kill 2>/dev/null
  pkill -P $$ 2>/dev/null
  pkill -f 'fswatch.*client/src' 2>/dev/null
  pkill -f 'fswatch.*[ /]server/' 2>/dev/null
  exit 0
}
trap cleanup EXIT INT TERM

# Reap watcher stragglers orphaned by a previously SIGKILL'd instance. `launchctl
# kickstart -k` SIGKILLs this script, bypassing the EXIT trap above, so each
# restart leaked the background fswatch LOOP SUBSHELLS (reparented to launchd,
# PPID 1) — and those respawn fswatch every 2 s forever, so 29 fswatch had piled
# up during the 2026-06-07 incident. Killing fswatch alone is not enough; we must
# kill the orphaned loop subshells too. The single-instance lock above means any
# other start-prod.sh process (PPID 1, not us) is a straggler.
for _p in $(pgrep -f 'topics-app/scripts/start-prod.sh' 2>/dev/null); do
  [ "$_p" = "$$" ] && continue
  [ "$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d ' ')" = "1" ] && kill -9 "$_p" 2>/dev/null
done
pkill -f 'fswatch.*client/src' 2>/dev/null
pkill -f 'fswatch.*[ /]server/' 2>/dev/null

# Client bundle: /public is a DEPLOY ARTIFACT, not a boot product (2026-07-13).
# The old unconditional `npx vite build` here rebuilt the client from the LIVE
# repo on every kickstart — which (a) kept the server DOWN for the whole build
# (minutes under launchd on a loaded box), and (b) shipped whatever WIP other
# sessions had in client/src, silently overwriting the clean-worktree build
# that the deploy flow rsyncs into /public (see CLAUDE.md: build SOLO da
# worktree pulito). Kickstart = server restart; the bundle only changes when a
# deploy deliberately replaces /public. Bootstrap-only fallback: build once if
# the bundle is missing entirely (fresh checkout).
if [ ! -f "$APP_DIR/public/index.html" ]; then
  echo "[start-prod] /public is empty — bootstrap client build"
  (cd client && npx vite build 2>&1 | tail -3)
fi

# ─── Client: STABLE bundle, no reload-on-source-change ─────────────────────
# The production app serves the /public bundle built once above. We deliberately
# do NOT watch client/src and auto-rebuild+reload. A vite build rewrites
# public/index.html, and Electron's asset-watcher then reloads EVERY window —
# blanking every pane (terminals repaint their xterm canvas, chats re-hydrate
# from the WS) on each rebuild. That is catastrophic whenever ANOTHER Claude
# session is editing client files: the running app flashes empty repeatedly
# (2026-06-22 incident — the symptom looked like empty/black panes).
#
# Live client hot-reload belongs in `bun run dev:client` (Vite HMR, see
# CLAUDE.md "Development"), NOT in this production launchd agent. To apply
# client source changes to the running app:
#   cd client && bun run build     # outDir ../public (client/vite.config.ts)
# then reload the app window.
#
# NON usare `launchctl kickstart -k` per questo. Diceva proprio così qui
# ("re-runs the initial `npx vite build` above, then Electron reloads once") e
# sono due cose false: quella build è dentro `if [ ! -f public/index.html ]`
# (riga 104), quindi su un'installazione con /public presente il kickstart non
# ricompila NIENTE — come spiega il blocco 95-103, scritto dopo, che l'ha resa
# condizionale apposta. E "Electron" è il guscio archiviato nella v2.0.0.
# Restava una procedura che costa un riavvio del server per zero effetto.

# ─── Server: STABLE run, no reload-on-source-change ────────────────────────
# The production server hosts LIVE Claude PTY sessions and every client's
# WebSocket. It must NOT restart itself when source changes. The previous
# behaviour watched server/** with fswatch and SIGTERM'd the server on every
# `.ts` save — which dropped ALL WebSockets (blanking every open pane) and the
# in-app Claude session connections. That is catastrophic whenever ANOTHER
# Claude session is actively editing server files: the running app flaps
# between reloads and panes show empty (2026-06-22 incident).
#
# Live hot-reload of server code belongs in `bun run dev:server` (see CLAUDE.md
# "Development"), NOT in this production launchd agent. To apply server source
# changes to the running app, reload it DELIBERATELY:
#   launchctl kickstart -k gui/$(id -u)/com.armonia.topics-server
# (`bun --watch` is also rejected: it restarts via SIGKILL, bypassing
# server.ts gracefulShutdown and orphaning the PTY bridge + claude children.)

# ─── Server hot-reload (OPT-IN, GRACEFUL) — 2026-07-18 ─────────────────────
# Default OFF → released/other installs stay byte-identical & STABLE. A dev
# machine can `export TOPICS_SERVER_WATCH=1` in ~/.topics-server-env to get hot
# reload done the SAFE way: on a server-source change we send SIGTERM to the
# running server so server.ts gracefulShutdown runs (clean singleton-lock
# release + bridge disconnect), and the restart loop below relaunches it — the
# new process re-acquires the lock cleanly and the ai-bridge broker + PTY-bridge
# sidecars reattach live chat/dispatch/terminal sessions (reload-resilience,
# landed after the 2026-06-22 incident). This is deliberately NOT `bun --watch`
# (SIGKILL → bypasses gracefulShutdown, races the lock) and NOT the old
# fswatch-on-every-save (no debounce → pane flap): fswatch is debounced 2s so a
# multi-file merge coalesces into ONE graceful reload. Only server/** + server.ts
# are watched (source-only; runtime writes go to data/, ai-bridge/, /tmp, public/).
# Un server piu' giovane di questa soglia sta ancora dentro l'init: la porta
# HTTP non e' aperta, quindi non puo' rispondere a `restart-when-idle`.
BIRTH_GRACE_S=25

if [ "${TOPICS_SERVER_WATCH:-0}" = "1" ]; then
  (
    fswatch -o -l 2 --event Updated --event Created --event Removed --event Renamed \
      "$APP_DIR/server/" "$APP_DIR/server.ts" 2>/dev/null \
    | while read -r _; do
        SP=$(cat "$SERVER_PIDFILE" 2>/dev/null)
        if [ -n "$SP" ] && kill -0 "$SP" 2>/dev/null; then
          # ─── Cancello di NASCITA (2026-08-26) ─────────────────────────────
          # Vivo non vuol dire pronto. Il ramo in fondo a questo blocco conclude
          # «non risponde nemmeno dopo l'attesa di nascita» e manda un SIGTERM
          # secco: ma se il server e' dentro l'init la porta HTTP non e' ancora
          # aperta, quindi NON POTEVA rispondere. Ucciderlo li' e' una trappola
          # che si autoalimenta — il rimpiazzo ci mette 15-20s a nascere, e
          # l'evento successivo lo trova nella stessa finestra, per sempre.
          #
          # Misurato il 26/08: 992 uscite nel log, ~17 minuti con l'app
          # irraggiungibile, ogni ciclo chiuso da «SIGTERM received during init
          # — nothing owned yet». La board non rispondeva: ECONNREFUSED.
          #
          # Qui il giro non si SALTA (una modifica persa e' un server che gira
          # con codice vecchio senza dirlo): si RINVIA. Aspettando che il server
          # compia BIRTH_GRACE_S si garantisce che l'attesa di nascita piu'
          # sotto parta da un server che la porta l'ha gia' aperta, e il
          # SIGTERM resta raggiungibile solo per un server davvero muto.
          # mtime del pidfile = istante di nascita: la riga 542 lo riscrive a
          # ogni rilancio, subito dopo lo spawn.
          while :; do
            _born=$(stat -f %m "$SERVER_PIDFILE" 2>/dev/null || echo 0)
            _age=$(( $(date +%s) - _born ))
            [ "$_age" -ge "$BIRTH_GRACE_S" ] && break
            kill -0 "$SP" 2>/dev/null || break   # e' uscito da solo: niente da rinviare
            echo "[start-prod] reload RINVIATO — il server ha ${_age}s, sta ancora nascendo (soglia ${BIRTH_GRACE_S}s)"
            sleep 2
          done
          # Cancello (2026-08-04): una modifica di più file è incoerente per
          # qualche secondo — l'import c'è, il modulo che lo soddisfa no. Far
          # ripartire il server proprio lì dentro l'ha già ucciso due volte il
          # 3 agosto (crash-loop su un modulo mancante; `createHumanWaitLedger
          # is not defined` su un export mancante, con un turno vivo perso e a
          # schermo «No response received»). Un albero a metà non merita di
          # sostituire un server che sta lavorando: se non compila si salta il
          # giro e il prossimo salvataggio riproverà. ~30ms.
          if ! GATE_OUT=$("$APP_DIR/scripts/server-reload-gate.sh" "$APP_DIR" 2>&1); then
            echo "[start-prod] reload SALTATO — l'albero non compila, il server vecchio resta su:"
            echo "$GATE_OUT" | sed 's/^/[start-prod]   /'
            sleep 2
            continue
          fi
          # PRIMA SI CHIEDE AL SERVER, e solo se non risponde si taglia.
          #
          # Il SIGTERM secco taglia i TURNI DEGLI AGENTI in volo. Misurato il
          # 18/08 mentre cinque card della board lavoravano: «Turno annullato:
          # riprovo tra 60s» tre volte in un minuto sulla stessa card, con il
          # budget dei tentativi che si svuotava e nessun lavoro che arrivava
          # mai in fondo. La causa erano i salvataggi su `server/` di chi stava
          # sviluppando: sviluppare e dispacciare insieme era impossibile.
          #
          # `/__daemon/restart-when-idle` esiste esattamente per questo: risponde
          # 202 subito, ASPETTA che i turni finiscano (cap suo) e poi si manda da
          # solo il SIGTERM, cosi' `gracefulShutdown` gira per intero. Lo dice
          # anche il commento della rotta: «use this instead of kickstart -k,
          # which SIGKILLs mid-turn».
          #
          # Se il server non risponde — non e' su, token illeggibile, curl
          # assente — si ricade sul SIGTERM di prima: un reload che non parte
          # sarebbe peggio.
          RELOAD_ASKED=0
          DSTATE="${TOPICS_HOME:-$HOME/.topics}/daemon-state.json"
          if [ -r "$DSTATE" ] && command -v curl >/dev/null 2>&1; then
            DTOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' "$DSTATE" | head -1)
            DPORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$DSTATE" | head -1)
            if [ -n "$DTOKEN" ] && [ -n "$DPORT" ]; then
              for SCHEME in https http; do
                RESP=$(curl -sk -m 5 -o /dev/null -w "%{http_code}" -X POST \
                  -H "Authorization: Bearer $DTOKEN" \
                  "$SCHEME://127.0.0.1:$DPORT/__daemon/restart-when-idle" 2>/dev/null)
                if [ "$RESP" = "202" ]; then
                  echo "[start-prod] server source changed → riavvio quando i turni finiscono (restart-when-idle)"
                  RELOAD_ASKED=1
                  break
                fi
              done
            fi
          fi
          if [ "$RELOAD_ASKED" = 1 ]; then
            # NON SI UCCIDE CHI NON HA ANCORA RICEVUTO IL SEGNALE.
            #
            # Su questo ramo il SIGTERM non l'abbiamo mandato noi: se lo manda il
            # server, DA SOLO, quando i turni finiscono (cap suo: 5 minuti).
            # L'escalation dell'altro ramo — sleep 10, cinque secondi di grazia,
            # SIGKILL a 15s — e' scritta per il caso opposto: segnale partito,
            # processo che lo ignora. Applicata anche qui ammazzava un server che
            # stava semplicemente ASPETTANDO, e un SIGKILL salta
            # `gracefulShutdown`: niente detach dei figli nel broker, i turni
            # tagliati a meta' — esattamente il danno che restart-when-idle
            # esiste per evitare. Misurato nel log il 2026-08-18: tutte e cinque
            # le volte in cui il cancello ha davvero atteso ([quiescence]
            # waiting…) il server e' uscito con code 137. Il cancello non ha mai
            # potuto arrivare in fondo nemmeno una volta.
            #
            # Qui si aspetta la SUA finestra, piu' un margine. Se la sfora,
            # allora si' che e' appeso — ma si comincia dal SIGTERM, non dal
            # martello.
            #
            # LA FINESTRA SI DERIVA, NON SI RISCRIVE. Era 330 fissi, cioe' i 5
            # minuti che il server usava allora: due numeri in due file che
            # devono dire la stessa cosa, e che al primo cambio da una parte si
            # sarebbero contraddetti. Adesso li decide la stessa variabile
            # (`TOPICS_QUIESCENCE_CAP_MS`, default 25 minuti = il tetto di un
            # turno d'agente piu' margine), e qui si aggiunge solo il margine
            # per il commiato.
            #
            # IL MARGINE E' 30s + LO SPEGNIMENTO, non 30s soli. Derivare lo
            # stesso NUMERO non basta se i due lo usano in modo diverso, ed e'
            # esattamente cosa e' successo al task 235afe11 il 20/08: il server
            # rinnovava la sua scadenza a ogni giro con del lavoro in volo,
            # quindi non scadeva mai; qui si contavano 1530s dall'inizio e poi
            # partiva il SIGTERM. Tre volte di fila, a 27 minuti esatti, con un
            # turno d'agente vivo ogni volta — worktree buttato e task rimesso
            # in coda.
            #
            # Il rinnovo e' stato tolto (il tetto del server ora e' vero), ma il
            # margine resta piu' largo: quando il server DECIDE di uscire deve
            # ancora eseguire `gracefulShutdown` per intero — fermare i
            # provider con la loro finestra di grazia (3,5s), staccare il
            # broker, chiudere il DB. Trenta secondi coprivano il commiato solo
            # se lo spegnimento fosse istantaneo, e non lo e'. Qui si concede
            # un minuto: se il server sfonda ANCHE questo, allora e' appeso
            # davvero ed e' giusto insistere.
            QCAP_S=$(( ${TOPICS_QUIESCENCE_CAP_MS:-1500000} / 1000 ))
            QWAIT=$(( QCAP_S + 60 ))
            echo "[start-prod]   aspetto che il server $SP si chiuda da solo (cap suo: $((QCAP_S / 60)) min)"
            #
            # IL RINVIO DEL SERVER BATTE QUESTO OROLOGIO (2026-08-28).
            #
            # Il server non taglia piu' un turno che nessuno riadotterebbe:
            # quando il tetto scade e c'e' ancora lavoro di quel tipo in volo,
            # RINVIA il riavvio e lo dichiara scrivendo un battito in
            # $TOPICS_HOME/reload-deferred. Senza guardarlo, questo `while`
            # scadrebbe comunque e manderebbe il SIGTERM: cioe' ucciderebbe il
            # turno proprio mentre il server lo sta proteggendo, e il rinvio
            # sarebbe la stessa morte di prima con un log piu' gentile.
            #
            # Il battito e' un ISTANTE, non una bandiera: un file rimasto li'
            # da un server morto invecchia e smette di trattenere, quindi un
            # server davvero appeso prende il SIGTERM come prima.
            DEFER_FILE="${TOPICS_HOME:-$HOME/.topics}/reload-deferred"
            DEFER_STALE_S=30
            deferring() {
              [ -f "$DEFER_FILE" ] || return 1
              _m=$(stat -f %m "$DEFER_FILE" 2>/dev/null || echo 0)
              [ $(( $(date +%s) - _m )) -lt "$DEFER_STALE_S" ]
            }
            WAITED=0
            DEFER_SAID=0
            while kill -0 "$SP" 2>/dev/null; do
              if deferring; then
                if [ "$DEFER_SAID" = 0 ]; then
                  echo "[start-prod]   il server RINVIA il riavvio: sta proteggendo un turno che non tornerebbe. Aspetto lui, non l'orologio."
                  DEFER_SAID=1
                fi
              elif [ "$WAITED" -ge "$QWAIT" ]; then
                break
              fi
              sleep 2
              WAITED=$((WAITED + 2))
            done
            if kill -0 "$SP" 2>/dev/null; then
              echo "[start-prod] ATTENZIONE: restart-when-idle accettato, ma il server $SP e' ancora vivo dopo ${WAITED}s — SIGTERM."
              kill -TERM "$SP" 2>/dev/null
              for _ in 1 2 3 4 5 6 7 8 9 10; do
                sleep 1
                kill -0 "$SP" 2>/dev/null || break
              done
              if kill -0 "$SP" 2>/dev/null; then
                echo "[start-prod] ATTENZIONE: ha ignorato anche il SIGTERM per 10s — SIGKILL."
                echo "[start-prod]   Un orfano lasciato vivo tiene il DB aperto e i suoi timer accesi."
                kill -KILL "$SP" 2>/dev/null
              fi
            fi
            # Il vecchio e' uscito: la finestra di settle serve lo stesso, perche'
            # il secondo batch di fswatch non deve colpire il server FRESCO a
            # meta' init (il perche' sta nel ramo qui sotto).
            sleep 5
          else
            # RAMO FALLBACK: restart-when-idle non ha risposto (server non
            # raggiungibile via HTTP, token mancante, curl assente).
            #
            # Prima di mandare SIGTERM, si controlla ancora una volta se il
            # server e' accessibile: potrebbe essersi avviato nel frattempo o
            # il token potrebbe essere diventato leggibile. Se risponde 202,
            # si passa al ramo paziente (come sopra). Questo copre il caso
            # principale del 2026-08-18: una modifica successiva ha sparato il
            # fallback mentre restart-when-idle era gia' pendente sul primo
            # evento — il server era vivo e raggiungibile, solo il primo curl
            # era fallito (es. token letto a meta' scrittura).
            RELOAD_ASKED2=0
            if [ -r "$DSTATE" ] && command -v curl >/dev/null 2>&1; then
              DTOKEN2=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' "$DSTATE" | head -1)
              DPORT2=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$DSTATE" | head -1)
              if [ -n "$DTOKEN2" ] && [ -n "$DPORT2" ]; then
                for SCHEME2 in https http; do
                  RESP2=$(curl -sk -m 5 -o /dev/null -w "%{http_code}" -X POST \
                    -H "Authorization: Bearer $DTOKEN2" \
                    "$SCHEME2://127.0.0.1:$DPORT2/__daemon/restart-when-idle" 2>/dev/null)
                  if [ "$RESP2" = "202" ]; then
                    echo "[start-prod] fallback → restart-when-idle raggiunto al secondo tentativo (aspetto i turni)"
                    RELOAD_ASKED2=1
                    break
                  fi
                done
              fi
            fi
            if [ "$RELOAD_ASKED2" = 1 ]; then
              # Stesso ramo paziente: il server si mandera' il SIGTERM da solo
              # quando i turni finiscono. Si aspetta la sua finestra (5 min + margine).
              echo "[start-prod]   aspetto che il server $SP si chiuda da solo (cap suo: 5 min)"
              FWAIT=0
              while kill -0 "$SP" 2>/dev/null && [ "$FWAIT" -lt 330 ]; do
                sleep 2
                FWAIT=$((FWAIT + 2))
              done
              if kill -0 "$SP" 2>/dev/null; then
                echo "[start-prod] ATTENZIONE: restart-when-idle (2° tentativo) accettato, server $SP ancora vivo dopo ${FWAIT}s — SIGTERM."
                kill -TERM "$SP" 2>/dev/null
                for _ in 1 2 3 4 5 6 7 8 9 10; do
                  sleep 1
                  kill -0 "$SP" 2>/dev/null || break
                done
                if kill -0 "$SP" 2>/dev/null; then
                  echo "[start-prod] ATTENZIONE: ha ignorato anche il SIGTERM per 10s — SIGKILL."
                  echo "[start-prod]   Un orfano lasciato vivo tiene il DB aperto e i suoi timer accesi."
                  kill -KILL "$SP" 2>/dev/null
                fi
              fi
              sleep 5
            else
              # NON SI UCCIDE UN SERVER CHE NON HA ANCORA POTUTO RISPONDERE.
              #
              # Si arriva qui quando `restart-when-idle` non ha risposto 202, e
              # per mesi la conclusione e' stata «allora non e' raggiungibile:
              # SIGTERM secco». Ma la causa piu' frequente non e' un server
              # rotto: e' un server APPENA NATO, ancora dentro l'init, che la
              # porta HTTP non l'ha ancora aperta. Un salvataggio emette due
              # batch di fswatch (write + rename) e il secondo arriva proprio
              # in quella finestra.
              #
              # Misurato sul log del 20/08: su 300 riavvii, 214 sono passati dal
              # cancello e 86 da qui — e nel campione guardato da vicino ognuno
              # colpiva un server nato da 11-18 secondi, che infatti moriva con
              # «SIGTERM received during init — nothing owned yet». Il server
              # ripartiva, un fswatch lo riuccideva, e via cosi': 151 uscite su
              # 200 sotto il minuto. In quella raffica i turni delle card non
              # avevano nessuna protezione, perche' il cancello che li tutela
              # sta DIETRO la porta che nessuno riusciva ad aprire.
              #
              # Dal lato delle CARD, contando una uccisione per evento (il
              # commento di requeue, non anche quello di chiusura): 93 turni
              # tagliati su 67 task. Fra due uccisioni dello stesso task ci sono
              # 26 intervalli — 7 sotto i cinque minuti, cioe' la raffica che
              # nasce QUI, contro 1 solo nella finestra 25-30 minuti, che era la
              # firma del cancello che non scadeva mai. Il difetto corretto
              # prima di questo era reale ma raro; questo e' quello che fa i
              # numeri.
              #
              # Quindi prima di rassegnarsi si concede al server il tempo di
              # nascere e si RIPROVA a chiedere il riavvio pulito. Trenta
              # secondi coprono un init tipico (2-4s) con margine largo su una
              # macchina carica. Solo se anche questo fallisce e' un server
              # davvero muto, e allora il SIGTERM e' la risposta giusta.
              RELOAD_ASKED3=0
              if [ -r "$DSTATE" ] && command -v curl >/dev/null 2>&1; then
                for _try in $(seq 1 15); do
                  sleep 2
                  kill -0 "$SP" 2>/dev/null || break   # e' gia' uscito da solo
                  DTOKEN3=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' "$DSTATE" | head -1)
                  DPORT3=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$DSTATE" | head -1)
                  [ -n "$DTOKEN3" ] && [ -n "$DPORT3" ] || continue
                  for SCHEME3 in https http; do
                    RESP3=$(curl -sk -m 3 -o /dev/null -w "%{http_code}" -X POST \
                      -H "Authorization: Bearer $DTOKEN3" \
                      "$SCHEME3://127.0.0.1:$DPORT3/__daemon/restart-when-idle" 2>/dev/null)
                    if [ "$RESP3" = "202" ]; then
                      echo "[start-prod] il server stava ancora nascendo: ora risponde → riavvio quando i turni finiscono"
                      RELOAD_ASKED3=1
                      break
                    fi
                  done
                  [ "$RELOAD_ASKED3" = 1 ] && break
                done
              fi
              if [ "$RELOAD_ASKED3" = 1 ]; then
                # Ramo paziente: aspetta la finestra del server, come sopra.
                QCAP_S3=$(( ${TOPICS_QUIESCENCE_CAP_MS:-1500000} / 1000 ))
                QWAIT3=$(( QCAP_S3 + 60 ))
                W3=0
                while kill -0 "$SP" 2>/dev/null && [ "$W3" -lt "$QWAIT3" ]; do
                  sleep 2
                  W3=$((W3 + 2))
                done
                if kill -0 "$SP" 2>/dev/null; then
                  echo "[start-prod] ATTENZIONE: il server $SP non e' uscito dopo ${W3}s — SIGTERM."
                  kill -TERM "$SP" 2>/dev/null
                fi
                sleep 5
                continue
              fi
              echo "[start-prod] server source changed → graceful hot-reload (SIGTERM $SP): non risponde nemmeno dopo l'attesa di nascita"
              kill -TERM "$SP" 2>/dev/null
              # Settle window: one save can emit TWO fswatch batches (write +
              # rename straddling the 2s latency). Without this pause the second
              # batch SIGTERMs the FRESH server mid-init — before server.ts has
              # registered its signal handlers — killing it with code 143 and
              # skipping gracefulShutdown. Sleeping here just delays the next
              # batch's reload until the new process is fully up (init is ~2-4s),
              # so every reload stays graceful.
              sleep 10
              # …E POI SI CONTROLLA CHE SIA MORTO DAVVERO.
              #
              # Prima qui c'era solo lo `sleep 10`: si mandava SIGTERM e si andava
              # avanti, dando per scontato che fosse bastato. Se il vecchio processo
              # NON esce — un `gracefulShutdown` che resta appeso su un turno in
              # volo, un handler che non ritorna — nessuno se ne accorge, e quello
              # resta su. Misurato il 2026-08-15: un `bun run server.ts` vivo da
              # 4h18m, reparentato a pid 1, senza piu' un socket in ascolto, che
              # teneva 89 MB per niente mentre il server nuovo lavorava accanto.
              # Non e' solo memoria sprecata: finche' e' vivo puo' ancora avere il
              # DB aperto e i suoi timer accesi.
              #
              # La finestra SIGKILL e' 60s (non 15): gracefulShutdown deve
              # distaccare i figli dal broker (stopAllProviders 3.5s + close
              # browserService + webrtcBridge.shutdown). Se l'operazione richiede
              # piu' di 15s — normale sotto carico — un SIGKILL prematuro salta
              # il detach e i figli nel broker non vengono staccati: la chat che
              # stava lavorando viene uccisa invece di essere riadottata al
              # riavvio. Misurato il 2026-08-18: sei SIGKILL in un giorno, ogni
              # volta dopo esattamente 15s, con partial sweep che diceva «reset 1»
              # invece di «kept 1».
              SIGKILL_WINDOW=60
              SIGKILL_WAITED=0
              if kill -0 "$SP" 2>/dev/null; then
                while kill -0 "$SP" 2>/dev/null && [ "$SIGKILL_WAITED" -lt "$SIGKILL_WINDOW" ]; do
                  sleep 1
                  SIGKILL_WAITED=$((SIGKILL_WAITED + 1))
                done
                if kill -0 "$SP" 2>/dev/null; then
                  echo "[start-prod] ATTENZIONE: il server $SP ha ignorato SIGTERM per ${SIGKILL_WAITED}s — SIGKILL."
                  echo "[start-prod]   Un orfano lasciato vivo tiene il DB aperto e i suoi timer accesi."
                  kill -KILL "$SP" 2>/dev/null
                fi
              fi
            fi
          fi
        fi
      done
  ) &
  echo "[start-prod] server hot-reload watch ON (graceful SIGTERM, debounce 2s, TOPICS_SERVER_WATCH=1)"
fi

# Restart-on-CRASH loop. An UNEXPECTED server exit drops us out of `wait` and we
# relaunch after a delay; launchd KeepAlive=true is the outer backstop if
# start-prod.sh itself dies. A SIGTERM to THIS script (launchd `bootout`, or the
# parent cleanup) interrupts `wait`, runs cleanup → SHUTTING_DOWN=1 → exit, so
# the loop never relaunches on a real shutdown. There is no reload-on-edit: the
# server only comes back after a genuine crash.
#
# ─── Backoff esponenziale sui boot-failure (2026-08-17) ─────────────────────
#
# Prima il loop riavviava sempre dopo 1s fisso, senza distinzione tra un crash
# dopo ore di lavoro e un boot che muore subito. Il 17/08: 506 boot falliti in
# 10 minuti e 38 secondi (01:00:48 → 01:11:26), un tentativo al secondo, senza
# nessun freno. L'app era giù e nessuno lo sapeva finché un umano non se ne è
# accorto.
#
# Un server che muore in meno di BOOT_THRESHOLD secondi non ha mai risposto a
# nessuna richiesta: è un boot-failure, non un crash di produzione. Riavviare 1
# volta al secondo mille volte non cambia il motivo del guasto; il backoff
# invece dà tempo a un operatore di accorgersi e intervenire, e salva il log da
# un muro di righe identiche che nasconde l'errore originale.
#
# Sequenza: 2s, 4s, 8s, 16s, 30s (tetto). Ogni exit che dura meno di
# BOOT_THRESHOLD aumenta il contatore; un server che sopravvive almeno
# BOOT_THRESHOLD secondi azzera il backoff (era un vero crash, non un loop).
BOOT_THRESHOLD=10   # secondi: meno di questo = boot-failure
BACKOFF_DELAY=2     # ritardo iniziale dopo un boot-failure (secondi)
BACKOFF_MAX=30      # tetto del backoff (secondi)
_backoff_cur=0      # ritardo corrente; 0 = primo giro / nessun boot-failure recente

while [ "$SHUTTING_DOWN" != 1 ]; do
  _boot_t="$(date +%s)"
  "$BUN" run "$APP_DIR/server.ts" &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$SERVER_PIDFILE"
  wait "$SERVER_PID"; code=$?
  # Re-check in case the SIGTERM raced in after `wait` returned but before the
  # trap set the flag — never relaunch once we're tearing down.
  [ "$SHUTTING_DOWN" = 1 ] && break

  _exit_t="$(date +%s)"
  _lived=$(( _exit_t - _boot_t ))

  if [ "$_lived" -lt "$BOOT_THRESHOLD" ]; then
    # Boot-failure: il server non ha raggiunto BOOT_THRESHOLD secondi di vita.
    if [ "$_backoff_cur" -lt "$BACKOFF_DELAY" ]; then
      _backoff_cur="$BACKOFF_DELAY"
    else
      _backoff_cur=$(( _backoff_cur * 2 ))
    fi
    [ "$_backoff_cur" -gt "$BACKOFF_MAX" ] && _backoff_cur="$BACKOFF_MAX"
    echo "[$(date +%H:%M:%S)] server exited after ${_lived}s (code $code) — boot-failure, riavvio tra ${_backoff_cur}s"
    sleep "$_backoff_cur"
  else
    # Crash dopo un avvio riuscito: azzera il backoff, breve pausa per non
    # intasare il log in caso di crash immediato post-avvio.
    _backoff_cur=0
    echo "[$(date +%H:%M:%S)] server exited after ${_lived}s (code $code) — relaunching in 1s"
    sleep 1
  fi
done
