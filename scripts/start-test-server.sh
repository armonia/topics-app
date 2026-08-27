#!/usr/bin/env bash
# start-test-server.sh — Avvia un server di test isolato.
#
# Lo usa il globalSetup di Playwright per far girare gli E2E contro un'istanza
# dedicata, con il suo SQLite sotto $DATA_DIR/topics.db.
#
# Porta e percorsi arrivano dall'AMBIENTE, con i default storici come fallback
# (13334 + /tmp/topics-test-data): è ciò che permette a più shard di girare
# insieme sulla stessa macchina, ognuno col suo server, il suo DB e i suoi
# socket. Chi chiama compone quell'ambiente in UN posto solo —
# `testServerEnv()` in tests/e2e/helpers/test-server.ts — e questo script si
# limita a colmare i buchi (`:-`), così un valore esplicito vince sempre.
#
# Il server legge BUN_PORT e DATA_DIR da environment (vedi server/utils.ts).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export BUN_PORT="${BUN_PORT:-13334}"
if [ "$BUN_PORT" = "13334" ]; then
  DEFAULT_DATA_DIR=/tmp/topics-test-data
else
  DEFAULT_DATA_DIR="/tmp/topics-test-data-${BUN_PORT}"
fi
export DATA_DIR="${DATA_DIR:-$DEFAULT_DATA_DIR}"
# @covers E2E-ISO-01
# E LO STESSO PERCORSO COME STATE_DIR, o l'isolamento vale solo per lo SQLite.
#
# `DATA_DIR` lo legge `server/db.ts` e basta. Tutto il resto dello stato
# mutabile passa da `resolveStateDir` (`server/lib/data-dir.ts`), che guarda
# SOLO `TOPICS_DATA_DIR`: senza, `STATE_DIR` ricade su `baseDir` = il repo, e i
# server di test scrivono `topics.json`, `unread.json`, `uploads/`,
# `context-files/`, `messages/` e `data/usage/` DENTRO LA CARTELLA VIVA, quella
# che usa anche il server di produzione.
#
# Misurato il 25/08: `uploads/` portava tre file `voice-*.m4a` con l'ora esatta
# di tre run e2e, e `data/usage/summary.json` l'mtime dell'ultima. Nella stessa
# corsa uno shard e' MORTO al boot — `initUsageStore` cancella all'avvio ogni
# file che contiene `.tmp.` nella sua cartella, e con quattro shard sulla
# stessa `data/usage/` la pulizia di uno ha cancellato la scrittura in volo di
# un altro (ENOENT sul rename, `server/usage/store.ts:47`, 253 test non
# eseguiti). Due nomi per la stessa idea, e uno dei due non lo leggeva nessuno.
export TOPICS_DATA_DIR="${TOPICS_DATA_DIR:-$DATA_DIR}"
# Phase 30 plan 30-05: dedicated TOPICS_HOME so the test server doesn't
# compete with the dev server (which holds ~/.topics/daemon-process.lock).
export TOPICS_HOME="${TOPICS_HOME:-$DATA_DIR/.topics-home}"
# Isolate OpenClaw config/session reads from the real user (server/utils.ts
# falls back to `${HOME}/.openclaw` when OPENCLAW_DIR is unset — SESSIONS_DIR
# derives from OPENCLAW_DIR the same way, so overriding this one var covers
# both). HOME itself is also overridden below for any other `~`-relative
# reads (e.g. utils.ts's ALLOWED_FILE_BASES, media dirs) — this is safe for
# PTY-spawned `claude`/`codex` terminal sessions specifically, since
# server/routes/terminal.ts pins THEIR env to `realHome()` (the real OS
# account home via getpwuid), not `process.env.HOME`, precisely so a sandboxed
# HOME here never leaks into those spawns (see server/utils/path-env.ts).
export OPENCLAW_DIR="${OPENCLAW_DIR:-$DATA_DIR/.openclaw}"
export HOME="$DATA_DIR/.home"
# UNO STUB DI `claude` DENTRO LA HOME ISOLATA, e non e' un trucco per far
# passare un test: e' la conseguenza diretta della riga qui sopra.
#
# `resolveClaudeBin()` cerca la CLI sotto `$HOME` (`~/.local/bin/claude` e
# fratelli). Da quando questo script isola HOME, quel percorso e' una cartella
# vuota, quindi il risolutore torna null ANCHE su una macchina dove la CLI e'
# installata — e da quando il server DICE che un agente manca invece di aprire
# una tab vuota (il difetto segnalato il 26/08), la POST di una sessione
# claude-code risponde 502 «"claude" is not installed on this machine».
#
# Misurato: era l'unico rosso rimasto della nightly (run 33025740083, 1 su
# 1076), e capitava anche su un Mac che la CLI ce l'ha. Il test misurava
# l'AMBIENTE, non il prodotto.
#
# E LO STUB DEVE CHIUDERE IL TURNO, che e' la lezione della prima versione.
# Con `exec cat` restava muto e vivo: bastava per la PTY, ma il RUNTIME della
# chat e' `claude-code`, cioe' passa dalla stessa CLI — e una CLI che non
# risponde mai lascia `POST /api/chat` appesa per sempre. Misurato: la richiesta
# non tornava entro 25s, il server continuava a dire `state: "streaming"` e il
# composer restava su `queue`, quindi `ink-latency` aspettava 60s un'azione
# `send` che non poteva arrivare. Un turno che non finisce e' peggio di un
# agente assente: assente lo dici, appeso no.
#
# Ora emette UNA riga in stream-json e esce 0. E' il minimo che un turno chiuso
# richiede, e resta muto su tutto il resto.
#
# `-f` e non `-e`: se qualcuno ci ha gia' messo un link alla CLI vera, vince lui.
mkdir -p "$HOME/.local/bin"
if [ ! -f "$HOME/.local/bin/claude" ]; then
  cat > "$HOME/.local/bin/claude" <<'STUB'
#!/usr/bin/env bash
# Stub del banco e2e. Vedi la nota in scripts/start-test-server.sh.
#
# DUE USI OPPOSTI, e vanno distinti o uno dei due e' sempre rotto:
#
#   - la CHAT (`claude-code` come RUNTIME) vuole un turno che FINISCE. Se lo
#     stub resta vivo, `POST /api/chat` non torna mai e il composer resta su
#     `queue` per sempre.
#   - la PTY di una sessione terminale vuole un processo che RESTA VIVO. Se
#     esce entro tre secondi il server la considera un lancio fallito e ne
#     CANCELLA la riga (giustamente: senno' ogni reload resusciterebbe una
#     chat che si richiude subito). Misurato: terminal-idle-park perdeva la
#     sessione a meta' file con «(non elencata)», 1 o 2 rossi a caso su 5.
#
# Si distinguono dagli argomenti, e il segno giusto e' `--print`: lo passa SOLO
# il runtime della chat, che vuole una risposta e basta. La PTY apre una
# sessione INTERATTIVA e non lo passa mai (server/routes/terminal.ts).
#
# Ci sono arrivato sbagliando due volte, e vale la pena scriverlo perche' il
# primo istinto e' proprio quello che non funziona: `--session-id` lo passano
# ENTRAMBI, e anche `--append-system-prompt` lo passano entrambi. L'ho visto
# solo stampando l'argv vero dello stub invece di dedurlo dal codice: la chat
# lancia `--print ... --append-system-prompt <istruzioni Topics> ... --session-id`.
# Un segno che c'e' in tutti e due i casi non distingue niente.
# `--version` e' una terza cosa ancora: chi sonda se la CLI esiste. Deve
# rispondere e uscire ZERO, senza entrare in nessuno dei due rami.
for arg in "$@"; do
  case "$arg" in
    --version|-v) printf 'claude 0.0.0-e2e-stub\n'; exit 0 ;;
  esac
done

interattivo=1
for arg in "$@"; do
  case "$arg" in
    --print|-p) interattivo=0 ;;
  esac
done

if [ "$interattivo" = "1" ]; then
  # Sessione di terminale: si comporta da guscio interattivo e RESTA VIVO.
  #
  # `sleep` in un ciclo e non `cat`: leggendo da una PTY, `cat` puo' tornare
  # subito (EIO, o un EOF appena il master non ha ancora scritto) e uscire
  # NON-ZERO — misurato, «exited in 382ms with code 1 — deleting (failed
  # launch)», cioe' esattamente il caso che questo ramo esiste per evitare.
  # Cosi' invece si resta finche' non ci uccidono, che e' come si comporta una
  # CLI interattiva, e si esce ZERO se qualcuno chiude con garbo.
  trap 'exit 0' TERM INT HUP
  while :; do sleep 3600 & wait $!; done
fi

# Turno di chat: una riga in stream-json e via.
#
# Il drenaggio in sottofondo NON e' cosmesi: chi ci lancia scrive il prompt
# sulla nostra stdin. Se usciamo senza che nessuno tenga aperto quel capo, la
# scrittura successiva trova la pipe chiusa e prende EPIPE — che nel banco ha
# ucciso il server di test e con lui 200 prove in un colpo solo. Questo `cat`
# sopravvive a noi giusto il tempo di assorbire il prompt e muore da se' quando
# chi scrive chiude.
cat >/dev/null 2>&1 &
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}\n'
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
exit 0
STUB
  chmod +x "$HOME/.local/bin/claude"
fi
# Dedicated PTY-bridge socket so EVERY server started via this script — the
# initial globalSetup server AND any in-test restart (terminal-session-resume)
# — is bridge-isolated. Without this, a restart that omits TOPICS_PTY_SOCKET
# falls back to the cwd-derived socket = the PRODUCTION bridge, whose live
# Claude PTYs the test reconcile then kills (knocking dev sessions dormant).
# Defaulted (`:-`) so an explicit value from globalSetup still wins.
export TOPICS_PTY_SOCKET="${TOPICS_PTY_SOCKET:-/tmp/topics-pty-bridge-e2e-${BUN_PORT}.sock}"
# Same isolation for the ai-bridge (stream-json broker) socket, for the same
# reason: a test server (or an in-test restart) must NEVER derive the cwd-based
# socket = the PRODUCTION ai-bridge. Harmless when TOPICS_AI_BRIDGE is unset
# (nothing connects); required the moment a broker restart-survival test enables
# the flag. Enable the feature for such a test with TOPICS_AI_BRIDGE=1.
export TOPICS_AI_BRIDGE_SOCKET="${TOPICS_AI_BRIDGE_SOCKET:-/tmp/topics-ai-bridge-e2e-${BUN_PORT}.sock}"
# Arma le route di reset della suite (`/api/test/checkpoint`, `/api/test/reset`).
# Svuotano ogni tabella: esistono SOLO dove questa variabile c'è, e questo script
# è l'unico posto che la mette. Vedi server/routes/e2e.ts.
export TOPICS_E2E="${TOPICS_E2E:-1}"
# Bundle servito: la FOTOGRAFIA di public/ fatta dal globalSetup, non la cartella
# viva del repo — che `vite build --watch` svuota e riscrive mentre i test
# girano, facendo cadere test a caso con la pagina inesistente. Arriva
# dall'ambiente (testServerEnv); vuoto = comportamento storico (public/ del repo),
# che è quello giusto per chi lancia questo script a mano.
export TOPICS_PUBLIC_DIR="${TOPICS_PUBLIC_DIR:-}"
# NIENTE GATEWAY FINTO, per la stessa ragione spiegata in
# tests/e2e/helpers/test-server.ts: dichiarare URL e token di un gateway che non
# ascolta fa eleggere `openclaw` a provider AI, e allora un messaggio inviato
# apre un turno che non finisce mai — il composer resta su `queue` e chi misura
# l'invio aspetta per sempre. Si passano solo se arrivano dall'ambiente, cosi'
# chi vuole provare l'integrazione vera li esporta e ottiene il comportamento
# di prima.
# Il TOKEN si dichiara sempre, l'URL solo se qualcuno ascolta davvero — e la
# differenza non e' un dettaglio. L'URL finto eleggeva `openclaw` a provider AI
# del banco (serve la coppia URL+token) verso una porta dove non risponde
# nessuno, e da li' nascevano i turni che non finivano mai. Il token invece fa
# un mestiere diverso che ha solo lo stesso nome: e' la credenziale legacy che
# `agentAuthOk()` accetta sulle route del terminale, e api-fixtures.ts la manda
# come `x-gateway-token` a ogni chiamata. Toglierlo — come avevo fatto al primo
# tentativo — faceva rispondere 401 al banco stesso: TERM-02 leggeva un buffer
# vuoto e cadeva con il prodotto sanissimo. Misurato: rosso 2 volte su 2 senza,
# verde con.
export GATEWAY_TOKEN="${GATEWAY_TOKEN:-test-token}"
if [ -n "${GATEWAY_URL:-}" ]; then export GATEWAY_URL; fi

# Ensure data + topics-home + isolated OpenClaw config/home directories exist
mkdir -p "$DATA_DIR" "$TOPICS_HOME" "$OPENCLAW_DIR" "$HOME"

cd "$REPO_ROOT"
exec bun run server.ts
