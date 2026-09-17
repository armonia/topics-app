#!/bin/bash
# ─── scripts/server-watch.sh — il hot-reload del server, in un processo suo ──
#
# Era un blocco di 360 righe dentro `start-prod.sh`, dentro una `( fswatch |
# while read )`: tre processi che nessuno poteva riavviare senza riavviare
# tutto il job launchd, cioe' il server con le sue sessioni. Estratto il
# 2026-09-03 perche' quel giorno e' servito UCCIDERLO: un cancello aveva
# riscritto 400 file identici, fswatch aveva accodato decine di eventi e il
# ciclo li smaltiva uno per riavvio. Da solo si puo' fermare, correggere e
# rilanciare (`scripts/server-watch.sh <APP_DIR> [<pidfile>]`) mentre il
# server continua a servire.
#
# What it does, in one line: when a file under server/, server.ts, or a shared/
# file the server imports changes CONTENT, it asks the server to restart once
# its turns are done (`/__daemon/restart-when-idle`), with the build gate in
# front and the SIGTERM as the last resort. Long comments live with the logic.
#
# Una sola istanza per macchina: il pidfile sotto /tmp ferma la seconda.
set -uo pipefail
APP_DIR="${1:?uso: server-watch.sh <APP_DIR> [<server pidfile>]}"
SERVER_PIDFILE="${2:-/tmp/topics-server.pid}"
MANAGED_PARENT_PID="${3:-}"
BIRTH_GRACE_S=25

WATCH_PIDFILE="${TOPICS_SERVER_WATCH_PIDFILE:-/tmp/topics-server-watch.pid}"
EVENT_PIPE="${TOPICS_SERVER_WATCH_EVENT_PIPE:-/tmp/topics-server-watch-events.$$}"
FSWATCH_PID=""
FSWATCH_WATCHDOG_PID=""
FSWATCH_STOP_GRACE_S="${TOPICS_FSWATCH_STOP_GRACE_S:-3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/server-watch-lock.sh"

cleanup() {
  trap - EXIT INT TERM
  stop_parent_watchdog
  if [ -n "$FSWATCH_WATCHDOG_PID" ]; then
    kill -TERM "$FSWATCH_WATCHDOG_PID" 2>/dev/null
    wait "$FSWATCH_WATCHDOG_PID" 2>/dev/null
    FSWATCH_WATCHDOG_PID=""
  fi
  if [ -n "$FSWATCH_PID" ] && kill -0 "$FSWATCH_PID" 2>/dev/null; then
    kill -TERM "$FSWATCH_PID" 2>/dev/null
    ( exec 9>&-; sleep "$FSWATCH_STOP_GRACE_S"; kill -KILL "$FSWATCH_PID" 2>/dev/null ) &
    STOP_GUARD_PID=$!
    wait "$FSWATCH_PID" 2>/dev/null
    kill -TERM "$STOP_GUARD_PID" 2>/dev/null
    wait "$STOP_GUARD_PID" 2>/dev/null
  fi
  release_process_lock "$WATCH_PIDFILE"
  rm -f "$EVENT_PIPE" 9>&-
  exit 0
}

acquire_process_lock "$WATCH_PIDFILE" "server-watch.sh" || exit 0
trap cleanup EXIT INT TERM
start_parent_watchdog "$MANAGED_PARENT_PID" "$$" || exit 1

if ! command -v fswatch >/dev/null 2>&1; then
  echo "[server-watch] fswatch non trovato: hot-reload spento (brew install fswatch)"
  exit 0
fi

# L'impronta di cio' che il server esegue: tutti i file sotto server/ piu'
# server.ts, ordinati, un solo sha. Non guarda mtime: e' il punto.
# A server that is alive but never answers is, on this machine, a main thread
# stuck in a synchronous syscall (2026-09-03: `openat` under a dead NFS mount
# of OrbStack, 30 minutes of outage while the code was searched for a bug).
# Say WHERE it is stuck and WHICH network mount does not answer, before the
# SIGTERM that will not work and the SIGKILL that will only breed a twin.
diagnose_stall() {
  local pid="$1" frames mnt
  frames=$(exec 9>&-; sample "$pid" 1 -mayDie 2>/dev/null | awk '/com.apple.main-thread/{f=1} f' | /usr/bin/grep -oE '[a-zA-Z_$]+\$?[A-Z_]*  \(in [a-zA-Z_.]+\)' | tail -3 | tr '\n' ' ')
  [ -n "$frames" ] && echo "[start-prod]   main thread del server $pid fermo in: $frames"
  mount 9>&- | /usr/bin/grep -vE '^(/dev/|devfs|map |autofs)' 9>&- | awk '{print $3}' 9>&- | (
    exec 9>&-
    while read -r mnt; do
      [ -d "$mnt" ] || continue
      ( ls "$mnt" >/dev/null 2>&1 & p=$!; sleep 3; if kill -0 $p 2>/dev/null; then kill -9 $p 2>/dev/null; echo "[start-prod]   mount di rete $mnt NON RISPONDE: qualunque accesso sincrono sotto quel path blocca il server. Sblocco: umount -f $mnt (o riavvia chi lo monta)"; fi )
    done
  )
}

BUN_BIN="${BUN:-$(exec 9>&-; command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"

# The shared/ files the SERVER imports, one per line, relative to APP_DIR.
#
# server.ts reaches into shared/ (shared/board.ts re-exports
# shared/machine-budget.ts, the admission rule of the dispatcher), and a land
# that touched only shared/ produced no event and no fingerprint change: the
# old rule kept running with nothing pending, while the commit looked landed.
# Not the whole of shared/, though: most of it is client code, and every
# client-only save would ask a restart that cuts turns for nothing. The module
# graph is the answer to "which of these does the server load": the same
# `bun build` the reload gate already runs (0.1 s, 677 inputs measured on
# 2026-09-15). When the tree does not build, every shared file counts: an
# extra reload is the safe side, and the gate stops it anyway.
server_shared_inputs() {
  (exec 9>&-; cd "$APP_DIR" || exit 0
    [ -d shared ] || exit 0
    if meta=$("$BUN_BIN" build server.ts --target=bun --packages=external --outfile=/dev/null --metafile=/dev/stdout 2>/dev/null); then
      printf '%s\n' "$meta" | sed -n 's/^    "\(shared\/[^"]*\)": {$/\1/p'
    else
      find shared -type f ! -path '*/node_modules/*'
    fi)
}

# Every file the running server is made of, NUL-separated, relative to APP_DIR.
server_sources() {
  (exec 9>&-; cd "$APP_DIR" || exit 0
    find server server.ts -type f ! -path '*/node_modules/*' -print0 2>/dev/null
    server_shared_inputs | tr '\n' '\0')
}

src_hash() {
  (exec 9>&-; cd "$APP_DIR" && server_sources | sort -z | xargs -0 shasum -a 1 2>/dev/null | shasum -a 1 | cut -c1-40)
}

# Print the first server source NOT older than the reference file $1, if any.
# "Not older" and not "newer": with one-second mtimes a file saved in the same
# second as the reference may not have been loaded, and that doubt must end in
# a restart, never in a skipped one. A missing reference makes every file count.
first_source_not_older_than() {
  (exec 9>&-; cd "$APP_DIR" || exit 0
    server_sources | while IFS= read -r -d '' f; do
      if ! [ "$1" -nt "$f" ]; then printf '%s\n' "$f"; break; fi
    done)
}

# Every age check below is arithmetic on an mtime, so the mtime must be a bare
# number on both stat dialects. GNU stat (the Linux CI runner) reads `-f` as its
# file-system flag and `%m` as a missing file: it prints a multi-line report of
# the volume, exits 1, and `|| echo 0` appends to that report instead of
# replacing it. Under `set -u` the arithmetic then dies on the report's first
# word ("File: unbound variable"), the watcher exits, and its successor hashes
# a tree that already contains the edit, so the reload is lost without a trace.
# The dialect is probed, not inferred from uname: a Mac with GNU coreutils
# first in PATH has a GNU stat too. BSD stat rejects `-c` without printing.
if (exec 9>&-; stat -c %Y / >/dev/null 2>&1); then
  file_mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
else
  file_mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }
fi
# Log label only. GNU date reads `-r` as a reference FILE, BSD date has no `-d`,
# so the first form that fails prints nothing and the other one answers.
epoch_clock() { date -d "@$1" +%H:%M:%S 2>/dev/null || date -r "$1" +%H:%M:%S 2>/dev/null; }

# ─── How long the watcher is patient with a server ─────────────────────────
#
# THE WINDOW IS DERIVED, NOT REWRITTEN. The server's own cap
# (`TOPICS_QUIESCENCE_CAP_MS`, default 25 minutes) plus a margin for its
# graceful shutdown. It used to be 330 s fixed, two numbers in two files that
# contradicted each other at the first change (task 235afe11, 20/08: SIGTERM at
# 27 minutes three times in a row, a live agent turn each time).
QCAP_S=$(( ${TOPICS_QUIESCENCE_CAP_MS:-1500000} / 1000 ))
QWAIT=$(( QCAP_S + ${TOPICS_SERVER_WATCH_EXIT_MARGIN_S:-60} ))
# How often a server that does not answer is asked again, and how long one
# answer may take. The route awaits `whatIsStillWorking()` before its 202, so on
# a machine in swap one answer takes as long as one event-loop stall.
ASK_EVERY_S="${TOPICS_SERVER_WATCH_ASK_EVERY_S:-10}"
ASK_TIMEOUT_S=30
# Between SIGTERM and SIGKILL. `gracefulShutdown` detaches the broker children,
# stops the providers (3.5 s grace) and closes the DB; a SIGKILL before it ends
# resets turns that would have been re-adopted. It was 15 s (six premature
# kills on 18/08), then 60 s, and on 14/09 a server stalled 87 s by swap took
# the SIGKILL 54 s into a shutdown that was still running.
SIGKILL_WINDOW_S=300

# THE SERVER'S DEFERRAL BEATS THE WATCHER'S CLOCK (2026-08-28).
#
# A server that will not cut work nobody would re-adopt DEFERS the restart and
# says so by touching $TOPICS_HOME/reload-deferred on every loop (twice a
# second). A heartbeat, not a flag: a file left behind by a dead server ages
# and stops holding.
#
# It is defined HERE, once, for every path that got a 202. It used to live
# inside the first branch only: a fresh watcher whose first ask timed out had
# no such function (exit 127, read as "not deferring"), and the third branch
# never looked at it at all. On 14/09 that third branch SIGTERMed server 34310
# after a flat 1560 s while it was writing "RINVIATO da 1557s, 12 turno/i di
# card": twelve cards cut mid-turn.
#
# THE STALENESS IS COUNTED IN STALLS, not in heartbeats. The loop touches the
# file every 500 ms, but under swap the whole loop stops: 7, 12, 25 and 87 s
# measured on 14/09. With 30 s a single long stall read as "no longer
# deferring" and the SIGTERM hit the turns the server was protecting. A server
# that is really gone is caught by `kill -0` long before this, so the threshold
# only separates "stalled" from "hung", and a hung server gains nothing from
# being signalled five minutes sooner.
DEFER_FILE="${TOPICS_HOME:-$HOME/.topics}/reload-deferred"
DEFER_STALE_S=300
deferring() {
  [ -f "$DEFER_FILE" ] || return 1
  _m=$(exec 9>&-; file_mtime "$DEFER_FILE")
  [ $(( $(exec 9>&-; date +%s) - _m )) -lt "$DEFER_STALE_S" ]
}

# POST /__daemon/restart-when-idle once. Exit 0 only on a 202. The token and the
# port are read again on every call: a token read while the file was being
# written is the most common reason a first ask fails (2026-08-18).
ask_restart_when_idle() {
  local dstate="${TOPICS_HOME:-$HOME/.topics}/daemon-state.json" token port scheme resp
  [ -r "$dstate" ] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  token=$(exec 9>&-; sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' "$dstate" | head -1)
  port=$(exec 9>&-; sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$dstate" | head -1)
  [ -n "$token" ] && [ -n "$port" ] || return 1
  for scheme in https http; do
    resp=$(exec 9>&-; curl -sk -m "$ASK_TIMEOUT_S" -o /dev/null -w "%{http_code}" -X POST \
      -H "Authorization: Bearer $token" \
      "$scheme://127.0.0.1:$port/__daemon/restart-when-idle" 9>&- 2>/dev/null)
    [ "$resp" = "202" ] && return 0
  done
  return 1
}

# The server accepted: it will SIGTERM itself when its turns are done. Wait for
# that, and do not count the time while it declares a deferral. Exit 0 when it
# exited, 1 when the window ran out with no deferral (WAITED holds the seconds).
wait_for_server_exit() {
  local pid="$1" said=0
  WAITED=0
  while kill -0 "$pid" 2>/dev/null; do
    if deferring; then
      if [ "$said" = 0 ]; then
        echo "[start-prod]   il server RINVIA il riavvio: sta proteggendo un turno che non tornerebbe. Aspetto lui, non l'orologio."
        said=1
      fi
    elif [ "$WAITED" -ge "$QWAIT" ]; then
      return 1
    fi
    sleep 2 9>&-
    WAITED=$((WAITED + 2))
  done
  return 0
}

# SIGTERM, then SIGKILL only if the process is still there after the window.
# An orphan left alive keeps the DB open and its timers running (measured
# 2026-08-15: a server alive for 4h18m, reparented to pid 1, beside the new one).
terminate_server() {
  local pid="$1" waited=0
  kill -TERM "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$SIGKILL_WINDOW_S" ]; do
    sleep 1 9>&-
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "[start-prod] ATTENZIONE: il server $pid ha ignorato SIGTERM per ${waited}s: SIGKILL."
    echo "[start-prod]   Un orfano lasciato vivo tiene il DB aperto e i suoi timer accesi."
    kill -KILL "$pid" 2>/dev/null
  fi
}

LAST_HASH=$(exec 9>&-; src_hash)
BOOT_SEEN=$(exec 9>&-; file_mtime "${TOPICS_HOME:-$HOME/.topics}/daemon-state.json")
echo "[start-prod] server hot-reload watch ON (graceful, debounce 2s, impronta ${LAST_HASH:0:8}, pid $$)"

rm -f "$EVENT_PIPE" 9>&-
mkfifo "$EVENT_PIPE" 9>&-
# shared/ is watched whole; the fingerprint decides which of its files matter
# to the server (see `server_shared_inputs`).
FSWATCH_PATHS=("$APP_DIR/server/" "$APP_DIR/server.ts")
[ -d "$APP_DIR/shared" ] && FSWATCH_PATHS+=("$APP_DIR/shared/")
fswatch -o -l 2 --event Updated --event Created --event Removed --event Renamed \
  "${FSWATCH_PATHS[@]}" 9>&- > "$EVENT_PIPE" 2>/dev/null &
FSWATCH_PID=$!
WATCH_OWNER_PID="$$"
(
  exec 9>&-
  while kill -0 "$WATCH_OWNER_PID" 2>/dev/null && process_has_parent "$FSWATCH_PID" "$WATCH_OWNER_PID"; do
    sleep "$WATCHDOG_INTERVAL_S"
  done
  if kill -0 "$FSWATCH_PID" 2>/dev/null; then
    kill -TERM "$FSWATCH_PID" 2>/dev/null
    sleep "$FSWATCH_STOP_GRACE_S"
    kill -KILL "$FSWATCH_PID" 2>/dev/null
  fi
) &
FSWATCH_WATCHDOG_PID=$!
while read -r _; do

        # ── DUE GUARDIE, nate dalla tempesta del 2026-09-03 ─────────────────
        # `check:deadcode-blindspots` appende una sonda a ~400 file sotto
        # server/ e li RIPRISTINA identici un minuto dopo. Per fswatch sono
        # centinaia di eventi, per il codice non e' cambiato niente; il vecchio
        # ciclo li smaltiva uno per riavvio (dalle 16:34 alle 16:43, ogni 30s,
        # uccidendo i turni claude-code in volo). Un evento mtime NON e' una
        # modifica: prima si guarda il contenuto.
        #
        # 1. Il file di HOLD: chi sa che sta per riscrivere i sorgenti (il
        #    cancello stesso) lo alza prima e lo toglie dopo. Finche' c'e' e ha
        #    meno di 20 minuti, nessun reload. Il tetto evita che una run morta
        #    a meta' spenga il reload per sempre.
        HOLD="$APP_DIR/.topics-reload-hold"
        if [ -f "$HOLD" ] && [ $(( $(exec 9>&-; date +%s) - $(exec 9>&-; file_mtime "$HOLD") )) -lt 1200 ]; then
          if [ "${HOLD_SAID:-0}" != 1 ]; then
            echo "[start-prod] reload TRATTENUTO — $HOLD presente: un cancello sta riscrivendo i sorgenti, si riprende quando lo toglie"
            HOLD_SAID=1
          fi
          continue
        fi
        HOLD_SAID=0
        # 1-bis. A server that booted AFTER the last reload request runs the
        #    tree as it was at ITS boot, not as it was when the request was
        #    made. Edits saved in between were already loaded, yet the stale
        #    LAST_HASH made the next event look like "changed again" and asked
        #    a second restart seconds after every boot (drain, fleet frozen:
        #    twice on 2026-09-04). The boot is stamped by daemon-state.json.
        DSTATE_BOOT="${TOPICS_HOME:-$HOME/.topics}/daemon-state.json"
        BOOT_NOW=$(exec 9>&-; file_mtime "$DSTATE_BOOT")
        if [ "$BOOT_NOW" != "${BOOT_SEEN:-}" ]; then
          BOOT_SEEN=$BOOT_NOW
          #    ...unless the tree has MOVED SINCE that boot. The event that wakes
          #    this loop can be the very edit the server did not load: on
          #    2026-09-06 a land merged two migrations 71 s after a boot, the
          #    fresh hash read here already contained them, and the guard
          #    declared them "already loaded" — the server ran the old code
          #    with no restart pending and the live DB never got its columns.
          #    A file newer than the boot stamp cannot have been loaded by it:
          #    when there is one, the impronta is NOT re-read, so the normal
          #    comparison below sees the change and asks the restart.
          _newer=$(exec 9>&-; first_source_not_older_than "$DSTATE_BOOT")
          if [ -z "$_newer" ]; then
            LAST_HASH=$(exec 9>&-; src_hash)
            echo "[start-prod] server (ri)partito alle $(exec 9>&-; epoch_clock "$BOOT_NOW"): impronta dei sorgenti riletta, nessun riavvio per modifiche gia' caricate"
            continue
          fi
          echo "[start-prod] server (ri)partito alle $(exec 9>&-; epoch_clock "$BOOT_NOW"), ma sotto server/ c'e' gia' qualcosa di piu' nuovo del boot (es. $_newer): l'impronta non si rilegge, si confronta"
        fi
        # 2. L'impronta del contenuto: uguale a quella dell'ultimo avvio (o
        #    dell'ultimo reload chiesto) significa che il server gira GIA' su
        #    questo codice. ~250ms per ~900 file: niente rispetto a un riavvio.
        NOW_HASH=$(exec 9>&-; src_hash)
        if [ "$NOW_HASH" = "$LAST_HASH" ]; then
          if [ "${SAME_SAID:-0}" != 1 ]; then
            echo "[start-prod] evento ignorato — il contenuto di server/ e' identico a quello in esecuzione (solo mtime)"
            SAME_SAID=1
          fi
          continue
        fi
        SAME_SAID=0
        SP=$(exec 9>&-; cat "$SERVER_PIDFILE" 2>/dev/null)
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
          # mtime del pidfile = istante di nascita: start-prod.sh lo riscrive a
          # ogni rilancio, subito dopo lo spawn.
          while :; do
            _born=$(exec 9>&-; file_mtime "$SERVER_PIDFILE")
            _age=$(( $(exec 9>&-; date +%s) - _born ))
            [ "$_age" -ge "$BIRTH_GRACE_S" ] && break
            kill -0 "$SP" 2>/dev/null || break   # e' uscito da solo: niente da rinviare
            echo "[start-prod] reload RINVIATO — il server ha ${_age}s, sta ancora nascendo (soglia ${BIRTH_GRACE_S}s)"
            sleep 2 9>&-
          done
          # A SERVER BORN AFTER THE LAST EDIT ALREADY RUNS IT.
          #
          # The boot guard above reads daemon-state.json, which a new server
          # writes seconds after it is spawned. An event read in that gap (the
          # events queued while the watcher waited for the previous server to
          # leave) saw the old stamp, skipped the guard, and asked a restart of
          # a server that had loaded the very same tree: on 2026-09-15 01:51
          # server 41467 was spawned at :10, wrote its state at :18, and got a
          # restart for two merges older than its birth, which then held the
          # 13 cards the boot had just resumed. The pidfile is written right
          # after the spawn, so every source not newer than it was loaded.
          if [ -z "$(exec 9>&-; first_source_not_older_than "$SERVER_PIDFILE")" ]; then
            LAST_HASH=$NOW_HASH
            echo "[start-prod] il server $SP e' nato dopo l'ultima modifica ai sorgenti: gira gia' su questo codice, nessun riavvio"
            continue
          fi
          # Cancello (2026-08-04): una modifica di più file è incoerente per
          # qualche secondo — l'import c'è, il modulo che lo soddisfa no. Far
          # ripartire il server proprio lì dentro l'ha già ucciso due volte il
          # 3 agosto (crash-loop su un modulo mancante; `createHumanWaitLedger
          # is not defined` su un export mancante, con un turno vivo perso e a
          # schermo «No response received»). Un albero a metà non merita di
          # sostituire un server che sta lavorando: se non compila si salta il
          # giro e il prossimo salvataggio riproverà. ~30ms.
          if ! GATE_OUT=$(exec 9>&-; "$APP_DIR/scripts/server-reload-gate.sh" "$APP_DIR" 2>&1); then
            echo "[start-prod] reload SALTATO — l'albero non compila, il server vecchio resta su:"
            echo "$GATE_OUT" 9>&- | sed 's/^/[start-prod]   /' 9>&-
            sleep 2 9>&-
            continue
          fi
          LAST_HASH=$NOW_HASH
          # ASK FIRST, AND KEEP ASKING. Cut only a server that never answers.
          #
          # A bare SIGTERM cuts the agent turns in flight (18/08: «Turno
          # annullato: riprovo tra 60s» three times a minute on one card while
          # someone was saving under server/). `restart-when-idle` answers 202,
          # waits for the turns, and SIGTERMs its own process so that
          # `gracefulShutdown` runs whole.
          #
          # A missing 202 is almost never a broken server. It used to be a
          # newborn one (the birth gate above handles that now), and today it
          # is a server in swap: the route answers after `whatIsStillWorking()`,
          # and with the event loop stopped for 7, 12, 23 and 87 s (14/09,
          # load 111) every short ask timed out. The old last resort gave up
          # after ~140 s, SIGTERMed three cards mid-turn and SIGKILLed the
          # shutdown 60 s later, while the server was answering HTTP again.
          # So the watcher asks again every ASK_EVERY_S, each ask allowed
          # ASK_TIMEOUT_S, for the whole window the server itself would take:
          # a reload is never urgent enough to cut live turns over a stall.
          ASK_T0=$(exec 9>&-; date +%s)
          ASK_SAID=0
          RELOAD_ASKED=0
          while kill -0 "$SP" 2>/dev/null; do
            if ask_restart_when_idle; then
              RELOAD_ASKED=1
              break
            fi
            ASKED_FOR=$(( $(exec 9>&-; date +%s) - ASK_T0 ))
            [ "$ASKED_FOR" -ge "$QWAIT" ] && break
            if [ "$ASK_SAID" = 0 ]; then
              echo "[start-prod] restart-when-idle non risponde (server $SP lento o in swap): richiedo ogni ${ASK_EVERY_S}s, per al massimo ${QWAIT}s, prima di tagliare"
              ASK_SAID=1
            fi
            sleep "$ASK_EVERY_S" 9>&-
          done
          if [ "$RELOAD_ASKED" = 1 ]; then
            echo "[start-prod] server source changed → riavvio quando i turni finiscono (restart-when-idle)"
            echo "[start-prod]   aspetto che il server $SP si chiuda da solo (cap suo: $((QCAP_S / 60)) min)"
            # The SIGTERM is the server's own, sent when its turns are done.
            # Only a server that outlives its window WITHOUT declaring a
            # deferral is hung, and even then it starts from SIGTERM.
            if ! wait_for_server_exit "$SP"; then
              echo "[start-prod] ATTENZIONE: restart-when-idle accettato, ma il server $SP e' ancora vivo dopo ${WAITED}s e non rinvia: SIGTERM."
              terminate_server "$SP"
            fi
          elif kill -0 "$SP" 2>/dev/null; then
            echo "[start-prod] server source changed → graceful hot-reload (SIGTERM $SP): non risponde nemmeno dopo l'attesa di nascita e ${ASKED_FOR:-0}s di richieste"
            diagnose_stall "$SP"
            terminate_server "$SP"
          fi
          # Settle window: one save can emit TWO fswatch batches (write +
          # rename straddling the 2 s latency), and the second one must not
          # find the fresh server mid-init.
          sleep 5 9>&-
        fi
done < "$EVENT_PIPE"
