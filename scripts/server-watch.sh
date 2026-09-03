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
# Cosa fa, in una riga: quando un file sotto server/ o server.ts cambia DI
# CONTENUTO, chiede al server di riavviarsi quando i turni sono finiti
# (`/__daemon/restart-when-idle`), con il cancello di compilazione davanti e
# il SIGTERM come ultima spiaggia. I commenti lunghi stanno dove sta la logica.
#
# Una sola istanza per macchina: il pidfile sotto /tmp ferma la seconda.
set -uo pipefail
APP_DIR="${1:?uso: server-watch.sh <APP_DIR> [<server pidfile>]}"
SERVER_PIDFILE="${2:-/tmp/topics-server.pid}"
BIRTH_GRACE_S=25

WATCH_PIDFILE="/tmp/topics-server-watch.pid"
if [ -r "$WATCH_PIDFILE" ]; then
  _other=$(cat "$WATCH_PIDFILE" 2>/dev/null)
  if [ -n "$_other" ] && [ "$_other" != "$$" ] && kill -0 "$_other" 2>/dev/null; then
    echo "[server-watch] gia' in ascolto (pid $_other): questa istanza esce"
    exit 0
  fi
fi
echo $$ > "$WATCH_PIDFILE"
trap 'rm -f "$WATCH_PIDFILE"' EXIT

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
  frames=$(sample "$pid" 1 -mayDie 2>/dev/null | awk '/com.apple.main-thread/{f=1} f' | /usr/bin/grep -oE '[a-zA-Z_$]+\$?[A-Z_]*  \(in [a-zA-Z_.]+\)' | tail -3 | tr '\n' ' ')
  [ -n "$frames" ] && echo "[start-prod]   main thread del server $pid fermo in: $frames"
  mount | /usr/bin/grep -vE '^(/dev/|devfs|map |autofs)' | awk '{print $3}' | while read -r mnt; do
    [ -d "$mnt" ] || continue
    ( ls "$mnt" >/dev/null 2>&1 & p=$!; sleep 3; if kill -0 $p 2>/dev/null; then kill -9 $p 2>/dev/null; echo "[start-prod]   mount di rete $mnt NON RISPONDE: qualunque accesso sincrono sotto quel path blocca il server. Sblocco: umount -f $mnt (o riavvia chi lo monta)"; fi )
  done
}

src_hash() {
  (cd "$APP_DIR" && find server server.ts -type f ! -path '*/node_modules/*' -print0 2>/dev/null \
    | sort -z | xargs -0 shasum -a 1 2>/dev/null | shasum -a 1 | cut -c1-40)
}
LAST_HASH=$(src_hash)
echo "[start-prod] server hot-reload watch ON (graceful, debounce 2s, impronta ${LAST_HASH:0:8}, pid $$)"

    fswatch -o -l 2 --event Updated --event Created --event Removed --event Renamed \
      "$APP_DIR/server/" "$APP_DIR/server.ts" 2>/dev/null \
    | while read -r _; do

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
        if [ -f "$HOLD" ] && [ $(( $(date +%s) - $(stat -f %m "$HOLD" 2>/dev/null || echo 0) )) -lt 1200 ]; then
          if [ "${HOLD_SAID:-0}" != 1 ]; then
            echo "[start-prod] reload TRATTENUTO — $HOLD presente: un cancello sta riscrivendo i sorgenti, si riprende quando lo toglie"
            HOLD_SAID=1
          fi
          continue
        fi
        HOLD_SAID=0
        # 2. L'impronta del contenuto: uguale a quella dell'ultimo avvio (o
        #    dell'ultimo reload chiesto) significa che il server gira GIA' su
        #    questo codice. ~250ms per ~900 file: niente rispetto a un riavvio.
        NOW_HASH=$(src_hash)
        if [ "$NOW_HASH" = "$LAST_HASH" ]; then
          if [ "${SAME_SAID:-0}" != 1 ]; then
            echo "[start-prod] evento ignorato — il contenuto di server/ e' identico a quello in esecuzione (solo mtime)"
            SAME_SAID=1
          fi
          continue
        fi
        SAME_SAID=0
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
          LAST_HASH=$NOW_HASH
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
              diagnose_stall "$SP"
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
