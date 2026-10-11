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
# COSA FA. Stampa UNA riga per cancello con il suo exit code, e alla fine esce
# non-zero se anche uno solo e' rosso. Non si ferma al primo rosso: un giro solo
# deve dire TUTTO cio' che c'e' da sistemare, altrimenti si scoprono i problemi
# uno alla volta, un giro per uno.
#
# IN PARALLELO, MA SOLO CIO' CHE E' INDIPENDENTE. Misurato a freddo nella VM
# cloud (4 vCPU): `typecheck` 100 s e `lint` 109 s, in fila, erano l'87% dei
# 240 s della barra veloce, mentre i 21 cancelli statici insieme ne costano 25.
# Girano ora in tre corsie: tipi, lint, statici. Le righe del riepilogo escono
# nello stesso ordine di prima (la corsia non cambia COSA si dice, solo quando).
# Cosa tiene al sicuro il parallelo:
#   · ogni cancello scrive solo nel PROPRIO file temporaneo (`$TMPD/<id>.*`),
#     nessun file condiviso e nessuna porta: l'unico che scrive nei sorgenti,
#     `check:deadcode-blindspots` (aggiunge una sonda a ogni file di progetto e
#     la toglie in `finally`), gira DA SOLO a corsie finite, altrimenti
#     typecheck e lint vedrebbero un export in piu';
#   · `check:tmp-canonical` e' statico apposta, nessun cancello qui usa /tmp
#     con un nome fisso;
#   · gli slot di `scripts/slot.ts` (typecheck, lint, deadcode) restano: la
#     macchina condivisa con altri agenti non viene sovraccaricata, il cancello
#     che non trova uno slot aspetta il suo turno invece di rifiutarsi.
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
#   `check:e2e-touched`  picks the e2e specs from the DIFF against a base branch,
#                        and it runs in the pull request CI (`e2e (0)`), whose
#                        verdict the board reads for each delivery
#                        (`github-ci:e2e`). Here only `--list`: on a Mac it
#                        refuses to run specs.
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
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# misura <id> <comando...>: esegue e lascia l'esito nei file di <id> sotto
# $TMPD. E' l'unica cosa che le corsie fanno; non stampa niente, cosi' le righe
# non si mescolano.
misura() {
  local id="$1"; shift
  local t0=$SECONDS out code
  out="$("$@" 2>&1)"; code=$?
  printf '%s' "$out" > "$TMPD/$id.out"
  printf '%s %s' "$code" "$((SECONDS - t0))" > "$TMPD/$id.res"
}

# riferisci <id>: stampa (se rosso) e registra l'esito di un cancello gia' misurato.
riferisci() {
  local nome="$1" code dt out ultima
  # Una corsia interrotta (Ctrl-C) non lascia l'esito: e' un rosso, non un verde.
  if [ -f "$TMPD/$nome.res" ]; then
    read -r code dt < "$TMPD/$nome.res"
    out="$(cat "$TMPD/$nome.out")"
  else
    code=99; dt=0; out="$nome: non ha lasciato un esito (corsia interrotta?)"
  fi
  ultima="$(printf '%s' "$out" | tail -1 | cut -c1-70)"
  if [ "$code" -ne 0 ]; then
    ROSSI=$((ROSSI + 1))
    esiti+=("$(printf '  %-24s ROSSO  %3ss  %s' "$nome" "$dt" "$ultima")")
    printf '%s\n' "$out" | tail -25
  else
    esiti+=("$(printf '  %-24s verde  %3ss  %s' "$nome" "$dt" "$ultima")")
  fi
}

esegui() {
  misura "$1" "${@:2}"
  riferisci "$1"
}

# I cancelli statici, in ordine di costo crescente. `check:deadcode-blindspots`
# non e' qui: scrive nei sorgenti e gira da solo, sotto.
STATICI=(check:any check:any-budget check:ref-callbacks check:nul check:eslint-disable
         check:test-skips check:emdash check:bloat check:route-shadowing check:typography check:ui-language check:comment-language
         check:identifier-language check:sleeps check:tmp-canonical
         check:module-mock-restore check:api-door
         check:untraced-tests check:spec-coverage
         check:migrations check:security check:deadcode)

echo "== guard rail statici, tipi e lint (in parallelo) =="
(for c in "${STATICI[@]}"; do misura "$c" bun run "$c"; done) &
misura typecheck bun run typecheck &
misura lint bun run lint &
wait

# Da solo, a corsie finite: aggiunge una sonda a ogni file di progetto.
misura check:deadcode-blindspots bun run check:deadcode-blindspots

# Il riepilogo nell'ordine di sempre: statici, blindspots, tipi, lint.
for c in "${STATICI[@]}" check:deadcode-blindspots typecheck lint; do
  riferisci "$c"
done

if [ "$VELOCE" = "0" ]; then
  echo "== unit + integrazione =="
  esegui test:unit bun run test:unit
fi

if [ "$SENZA_E2E" = "0" ] && [ "$(uname -s)" = "Darwin" ] && [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  # Chromium does not run on the owner's Mac (playwright.config.ts refuses):
  # the e2e of a branch is the pull request CI, not a red bar here.
  echo "== E2E: not on this Mac, the pull request CI runs it =="
  SENZA_E2E=1
fi

if [ "$SENZA_E2E" = "0" ]; then
  echo "== E2E (2 shard) =="
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
