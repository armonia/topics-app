#!/usr/bin/env bash
# e2e-shards.sh — run the E2E suite as N shards side by side on this machine.
#
# WHY IT EXISTS. `playwright.config.ts` pins `workers: 1`, and the reason is
# sound: the workers of one run share a server and a database, so a second worker
# races the first. Sharding is a different axis and the repo already supports it
# fully. `E2E_PORT` gives each shard its own port, its own `DATA_DIR`, its own
# frozen bundle and its own tunnel port (`helpers/test-server.ts`), which is
# exactly how CI runs four of them. Locally nobody did, so the whole suite ran
# end to end on one shard and took as long as it takes.
#
# PORTS. `tunnelPortFor()` is `port + 1000`, and the main ports occupy 13334 plus
# the worktree band 13500-13899. Shards start at 13910 so neither the ports nor
# their tunnels (14910 and up) can land on somebody else's main port. Override
# with E2E_SHARD_BASE_PORT if you are running two of these at once, which you
# probably should not.
#
# LOAD, and the default is 2 because of a measurement, not a hunch. Every shard
# is a headless Chrome AND a Bun server. CI runs four, but CI gives each shard its
# own runner; here they share one laptop that is already carrying the production
# server and the app.
#
#   2026-08-21, same 47 specs (119 tests), this machine:
#     1 shard   246s   all green
#     2 shards  149s   all green      load 7.1 -> 15.7
#     4 shards   84s   TWO SHARDS DEAD: one test server never answered within
#                      30s, another died mid-run and took 8 tests with it
#
# The four-shard run is not faster, it is broken: the wall clock is short because
# a third of the suite never ran. Raise it only on a machine you know is idle, and
# read the load line this script prints before believing a red.
#
# Usage:
#   scripts/e2e-shards.sh                                  # 2 shards, whole suite
#   scripts/e2e-shards.sh 4 tests/e2e/board-*.spec.ts      # 4 shards, a subset
#   TOPICS_E2E_BUNDLE_DIR=... scripts/e2e-shards.sh        # against a built bundle
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_PORT="${E2E_SHARD_BASE_PORT:-13910}"
OUT_DIR="${TMPDIR:-/tmp}/topics-e2e-shards"

SHARDS=2
case "${1:-}" in
  ''|*[!0-9]*) : ;;             # first argument is not a number: keep the default
  *) SHARDS="$1"; shift ;;
esac
[ "$SHARDS" -ge 1 ] 2>/dev/null || { echo "✗ numero di shard non valido: $SHARDS" >&2; exit 1; }

rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"
cd "$REPO_ROOT"

LOAD_BEFORE="$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1}')"
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || echo 8)"
echo "▸ $SHARDS shard, porte $BASE_PORT-$((BASE_PORT + SHARDS - 1)), log in $OUT_DIR"
echo "  carico prima: $LOAD_BEFORE su $NCPU core"
# A shard that dies looks exactly like a shard that found a bug, and the only way
# to tell them apart afterwards is knowing what the machine was doing.
if awk -v l="$LOAD_BEFORE" -v n="$NCPU" 'BEGIN{exit !(l > n/2)}' 2>/dev/null; then
  echo "  ⚠ la macchina e' gia' carica: un server di test che non parte qui NON e' un test rotto" >&2
fi
[ -n "${TOPICS_E2E_BUNDLE_DIR:-}" ] && echo "  bundle: $TOPICS_E2E_BUNDLE_DIR"
echo

STARTED=$(date +%s)

# ── BILANCIAMENTO PER DURATA ────────────────────────────────────────────────
#
# `--shard=i/N` di Playwright riparte i file per NUMERO DI TEST: non conosce le
# durate, quindi non sa che un file può costare quanto quaranta. Misurato su
# questa macchina il 24/08, suite intera in modalità evidenza a 2 shard:
#
#   shard 1   51,8 min   568 test        <- il wall-clock è QUESTO
#   shard 2   34,8 min   552 test
#   lavoro totale 78,4 min: bilanciato sarebbero 39 min a testa
#
# Diciassette minuti di macchina ferma ad aspettare, con lo stesso lavoro fatto.
#
# `e2e-plan-shards.ts` esiste da tempo e fa esattamente questo (LPT sulle durate
# di `e2e-durations.json`), ma NESSUNO lo chiamava: questo script tirava dritto
# su `--shard`. Ora il piano si calcola una volta sola e ogni shard riceve la
# sua lista di file.
#
# SE IL PIANO NON SI PUÒ FARE si torna a `--shard=i/N` e la suite gira lo
# stesso: il bilanciamento rende la corsa più corta, non più corretta. Un piano
# mancante non deve mai essere il motivo per cui i test non partono.
PLAN_DIR="$OUT_DIR/plan"
USE_PLAN=0
if [ "$SHARDS" -gt 1 ] && [ "$#" -eq 0 ]; then
  if bun run scripts/e2e-plan-shards.ts "$SHARDS" --out "$PLAN_DIR" > "$OUT_DIR/plan.log" 2>&1; then
    USE_PLAN=1
    sed -E 's/^/  /' "$OUT_DIR/plan.log"
    echo
  else
    echo "  ⚠ piano non calcolabile, si torna a --shard=i/N (vedi $OUT_DIR/plan.log)" >&2
    echo
  fi
fi

pids=""
for i in $(seq 1 "$SHARDS"); do
  port=$((BASE_PORT + i - 1))
  # Con il piano: la lista dei file di QUESTO shard, uno per riga, come
  # argomenti posizionali. Senza: la vecchia divisione per numero.
  if [ "$USE_PLAN" = "1" ]; then
    # shellcheck disable=SC2207
    sel=($(cat "$PLAN_DIR/shard-$i.txt"))
    shard_args=("${sel[@]}")
    modo="piano"
  else
    shard_args=("--shard=$i/$SHARDS")
    modo="--shard"
  fi
  # IL REPORT JSON SI SCRIVE SEMPRE, non solo in modalita' evidenza.
  #
  # In evidenza serve per la pagina UAT (gli esiti vengono da li', non dal testo
  # del reporter). Ma serve anche SENZA, per un motivo che si e' visto sul
  # campo: e' l'unica fonte da cui `e2e-record-durations.ts` puo' rileggere
  # quanto e' costato ogni file, e senza durate fresche il piano bilancia sui
  # numeri sbagliati. Misurato: i pesi registrati CON video+trace usati per
  # pianificare una corsa SENZA li sovrastimano di 2,46x — e non in modo
  # uniforme, quindi il piano sbilancia proprio dove pesa.
  #
  # `--reporter=line,json` da' tutte e due: la riga da leggere mentre gira e il
  # file da cui imparare per la prossima volta. Costa un file per shard.
  E2E_PORT="$port" PLAYWRIGHT_JSON_OUTPUT_FILE="$OUT_DIR/report-$i.json" \
    npx playwright test "${shard_args[@]}" --reporter=line,json "$@" \
    > "$OUT_DIR/shard-$i.log" 2>&1 &
  pids="$pids $!"
  echo "  shard $i/$SHARDS  porta $port  pid $!  ($modo)"
done

# `wait` per pid, so one shard failing does not hide the others: we want every
# exit code, not the first bad one.
rc_total=0
i=0
for pid in $pids; do
  i=$((i + 1))
  wait "$pid"; rc=$?
  [ "$rc" -ne 0 ] && rc_total=1
  eval "rc_$i=$rc"
done
ELAPSED=$(( $(date +%s) - STARTED ))

echo
echo "▸ esito dopo ${ELAPSED}s (carico: $LOAD_BEFORE → $(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1}'))"
for i in $(seq 1 "$SHARDS"); do
  eval "rc=\$rc_$i"
  # The line reporter repaints with cursor escapes, and they survive into the log:
  # without stripping them the summary reads as "[1A[2K  32 passed".
  line="$(grep -E '[0-9]+ (passed|failed)' "$OUT_DIR/shard-$i.log" | tail -1 \
          | LC_ALL=C sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr -d '\r' | sed -E 's/^ +//')"
  [ -z "$line" ] && line="(nessun riepilogo: guarda $OUT_DIR/shard-$i.log)"
  if [ "$rc" -eq 0 ]; then printf "  ✓ shard %d/%d  %s\n" "$i" "$SHARDS" "$line"
  else printf "  ✗ shard %d/%d  %s\n" "$i" "$SHARDS" "$line"; fi
done

if [ "$rc_total" -ne 0 ]; then
  echo
  echo "I test caduti, per shard:"
  for i in $(seq 1 "$SHARDS"); do
    grep -E '^\s+[0-9]+\) ' "$OUT_DIR/shard-$i.log" | sed "s/^/  [shard $i] /" || true
  done
fi
exit "$rc_total"
