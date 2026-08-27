#!/usr/bin/env bash
# qa-gate.sh - LA BARRA, in un comando solo.
#
# PERCHE'. I cancelli di questo repo sono una ventina, sparsi fra `package.json`
# e `.github/workflows/ci.yml`, e la domanda che un umano si fa e' una sola:
# «e' verde?». Rispondere richiedeva di ricordarsene venti e di leggerne venti
# uscite. Un cancello che nessuno esegue non e' una protezione: e' la sua
# imitazione, e costa di piu' di non averlo perche' fa credere che la classe di
# difetti sia coperta.
#
# COSA FA. Li esegue in ordine di costo crescente, stampa UNA riga per cancello
# con il suo exit code, e alla fine esce non-zero se anche uno solo e' rosso.
# Non si ferma al primo rosso: un giro solo deve dire TUTTO cio' che c'e' da
# sistemare, altrimenti si scoprono i problemi uno alla volta, un giro per uno.
#
# Uso:
#   ./scripts/qa-gate.sh              tutto (E2E compresa: minuti)
#   ./scripts/qa-gate.sh --veloce     salta E2E e unit (secondi)
#   ./scripts/qa-gate.sh --senza-e2e  tutto tranne la suite E2E
#
# LA REGOLA DI APPARTENENZA, scritta perche' e' stata violata. Questa barra
# deve essere un SOVRAINSIEME dei cancelli statici che la CI blocca, altrimenti
# dice «verde» su una macchina dove la CI dira' rosso — ed e' esattamente cosa
# e' successo: `check:identifier-language`, `check:spec-coverage` e
# `check:deadcode-blindspots` erano in `ci.yml` e non qui, e il 26/08 il primo
# era ROSSO mentre questo script stampava BARRA VERDE. Costano 0s, 0s e 4s:
# non erano fuori per il prezzo, erano fuori perche' nessuno aveva confrontato
# le due liste. Chi aggiunge un cancello statico a `ci.yml` lo aggiunge anche
# qui, nello stesso commit.
#
# I due che restano fuori con un motivo, e non per dimenticanza:
#   `check:e2e-touched`  sceglie le spec e2e a partire dal DIFF con un ramo base,
#                        quindi ha bisogno di un base contro cui confrontarsi: in
#                        `ci.yml` gira solo su `pull_request`, dove quel base
#                        esiste. Qui non ce l'ha, e senza base non seleziona
#                        niente — un verde che non ha guardato nulla. Si lancia a
#                        mano prima di consegnare: `bun run check:e2e-touched`.
#   `check:bundle`       pretende `public/` gia' costruito (`bun run build:client`,
#                        minuti): in CI viene dopo una build che qui non c'e'.
#                        Dal 26/08 non puo' piu' mentire su una build vecchia:
#                        se i sorgenti sono piu' recenti esce 2 e non misura
#                        (GATE-BUNDLE-FRESH-01).
#   `check:previews`     misura il DATABASE VIVO della board e la cartella media
#                        di questo utente, non il checkout. In una barra deve
#                        dare la stessa risposta su qualunque macchina; questo
#                        darebbe la risposta del Mac di chi la lancia. Si lancia
#                        a mano: `bun run check:previews`.
#
# COSA NON FA, di proposito: i cancelli di TEMPO (`check:ink`, `check:drag`,
# `check:scroll-fluidity`, `check:growth`, `check:route-latency`,
# `probe:boot-memory`) NON stanno qui.
# Misurano millisecondi e frame, e su una macchina carica descrivono la
# macchina invece del codice: la stessa passata ha gia' dato 13,9% e 1,7% di
# frame persi a tre minuti di distanza, a codice fermo. Vanno lanciati a mano,
# a macchina quieta, mediana di cinque. Metterli qui vorrebbe dire insegnare a
# ignorare un rosso, che e' il modo in cui una barra muore.
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

VELOCE=0; SENZA_E2E=0
for a in "$@"; do
  case "$a" in
    --veloce) VELOCE=1; SENZA_E2E=1 ;;
    --senza-e2e) SENZA_E2E=1 ;;
    *) echo "opzione sconosciuta: $a" >&2; exit 2 ;;
  esac
done

ROSSI=0
esiti=()

esegui() {
  local nome="$1"; shift
  local t0=$SECONDS
  local out; out="$("$@" 2>&1)"; local code=$?
  local dt=$((SECONDS - t0))
  local ultima; ultima="$(printf '%s' "$out" | tail -1 | cut -c1-70)"
  if [ $code -ne 0 ]; then
    ROSSI=$((ROSSI + 1))
    esiti+=("$(printf '  %-24s ROSSO  %3ss  %s' "$nome" "$dt" "$ultima")")
    printf '%s\n' "$out" | tail -25
  else
    esiti+=("$(printf '  %-24s verde  %3ss  %s' "$nome" "$dt" "$ultima")")
  fi
}

echo "== guard rail statici =="
for c in check:any check:any-budget check:ref-callbacks check:nul check:eslint-disable \
         check:test-skips check:emdash check:bloat check:ui-language check:comment-language \
         check:identifier-language check:sleeps \
         check:untraced-tests check:spec-coverage \
         check:migrations check:security check:deadcode check:deadcode-blindspots; do
  esegui "$c" bun run "$c"
done

echo "== tipi e lint =="
esegui typecheck bun run typecheck
esegui lint bun run lint

if [ "$VELOCE" = "0" ]; then
  echo "== unit + integrazione =="
  esegui test:unit bun run test:unit
fi

if [ "$SENZA_E2E" = "0" ]; then
  echo "== E2E (4 shard) =="
  esegui e2e ./scripts/e2e-shards.sh
fi

echo
echo "════════════════════════════════════════════════════════════════"
printf '%s\n' "${esiti[@]}"
echo "════════════════════════════════════════════════════════════════"
if [ "$ROSSI" -gt 0 ]; then
  echo "BARRA ROSSA: $ROSSI cancello/i."
  exit 1
fi
echo "BARRA VERDE."
