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
  # Il ciclo vive in `scripts/server-watch.sh`: un processo che si puo'
  # fermare e rilanciare da solo, senza toccare il server (vedi la sua testa).
  "$APP_DIR/scripts/server-watch.sh" "$APP_DIR" "$SERVER_PIDFILE" &
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

  # Exit 137 = SIGKILL from OUTSIDE: nothing in this script or in server.ts
  # sends it (gracefulShutdown runs on SIGTERM). Measured 2026-09-06: three
  # such kills in one night, each cutting board turns mid-flight, and no
  # sender found in the test teardowns, the kernel log or the code. macOS
  # cannot say who signalled a process after the fact, so this snapshot is
  # taken the instant the child is reaped: a killer that is still a running
  # shell (`kill`, `pkill`, `launchctl kickstart`), and whoever else is on
  # :3333 at that moment, are the only two clues we can still collect.
  if [ "$code" -eq 137 ]; then
    echo "[$(date +%H:%M:%S)] server pid $SERVER_PID got SIGKILL (exit 137) after ${_lived}s — forensic snapshot:"
    ps -eo pid,ppid,etime,args 2>/dev/null | grep -Ei 'kill|kickstart|bootout' | grep -v grep | sed 's/^/    [ps] /' | head -20
    lsof -nP -iTCP:3333 2>/dev/null | sed 's/^/    [3333] /' | head -12
  fi

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
