#!/usr/bin/env bash
#
# specflow-evidence.sh — from the state of the code to the page on specflow.armonia.io.
#
# Bash and not a chain of `&&` because three things do not fit in one: merging N shard reports,
# skipping the video work when the suite never produced any, and saying what each stage cost.
#
# IT PUBLISHES EVEN WHEN THE SUITE IS RED, on purpose. A page showing three failures out of a
# thousand is the truth; one that refuses to appear until everything is green is the same as not
# having it — and the run that matters most is the one that went badly.
#
#   ./scripts/specflow-evidence.sh              # full suite with video + trace, then publish
#   SKIP_E2E=1 ./scripts/specflow-evidence.sh   # publish the report already on disk (~1-3 min)
#   SHARDS=1 ./scripts/specflow-evidence.sh     # one shard, for a quiet machine
#   SKIP_UNIT=1 ./scripts/specflow-evidence.sh  # reuse the JUnit report already on disk
#   E2E_SHOT=0 ./scripts/specflow-evidence.sh   # senza poster (~20 MB in meno, card grigie)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

test -d spec-flow || {
  echo "✗ manca spec-flow/ — è in .gitignore:218, quindi assente da OGNI checkout pulito." >&2
  echo "  clone: git clone git@github.com:armonia/spec-flow.git spec-flow" >&2
  exit 1
}

# Two shards, not four. scripts/e2e-shards.sh:20-31 records the measurement: at four, two shards
# died and a third of the suite never ran — and a wall clock that short reads like a win.
SHARDS="${SHARDS:-2}"
SKIP_E2E="${SKIP_E2E:-0}"
# `ONLY_ANNOTATED=1`: gira SOLO i file che dichiarano un requisito per-test
# (`test.info().annotations.push({type:"spec", …})`). Sono gli unici che possono produrre un
# esito e un trace per-requisito: gli altri restano «coperto, non eseguito qui» comunque, prima
# e dopo. Su topics-app sono 121 file su 264, cioe' meno della meta' del tempo per la STESSA
# pagina. Non sostituisce la suite intera — quella dice se qualcosa e' rotto, e va lanciata — ma
# per aggiornare la living-doc e' il giro giusto.
ONLY_ANNOTATED="${ONLY_ANNOTATED:-0}"
OUT_DIR="${TMPDIR:-/tmp}/topics-e2e-shards"
MERGED="test-results/uat-report.json"
MAP="openspec/coverage-map.json"
JUNIT="test-results/bun-junit.xml"

step() { echo; echo "▸ $*"; }
since() { echo "  ($(( $(date +%s) - $1 ))s)"; }

rc=0
RAN=0
if [ "$SKIP_E2E" != "1" ]; then
  # IL BUNDLE ISOLATO, non `public/`. `global-setup.ts` rifiuta di girare contro un bundle piu'
  # vecchio dei sorgenti — e ha ragione, la suite proverebbe il codice di prima. Senza questa
  # riga la catena moriva in 94s con due shard senza verdetto: `public/` appartiene all'app viva
  # e non si ricostruisce, quindi e' sempre indietro appena si tocca il client.
  step "bundle isolato (da HEAD, non dalla working tree)"
  t=$(date +%s)
  BUNDLE_OUT="$("$REPO_ROOT/scripts/e2e-isolated-bundle.sh" 2>&1)" || { echo "$BUNDLE_OUT" >&2; exit 1; }
  BUNDLE="$(printf '%s\n' "$BUNDLE_OUT" | sed -n 's/.*TOPICS_E2E_BUNDLE_DIR=\([^ ]*\).*/\1/p' | head -1)"
  [ -d "$BUNDLE" ] || { echo "✗ non ho ricavato il path del bundle da e2e-isolated-bundle.sh" >&2; exit 1; }
  echo "  $BUNDLE"
  since "$t"

  SEL=()
  if [ "$ONLY_ANNOTATED" = "1" ]; then
    while IFS= read -r f; do SEL+=("${f}\$"); done < <(
      /usr/bin/grep -lE 'type:[[:space:]]*["'"'"']spec["'"'"']' tests/e2e/*.spec.ts | sed 's/\./\\./g'
    )
    [ ${#SEL[@]} -gt 0 ] || { echo "✗ ONLY_ANNOTATED=1 ma nessun file dichiara un requisito per-test." >&2; exit 1; }
    step "suite E2E — $SHARDS shard, SOLO i ${#SEL[@]} file con annotazione per-test"
  else
    step "suite E2E — $SHARDS shard, trace su tutti i test"
  fi
  t=$(date +%s)
  E2E_EVIDENCE=1 E2E_SHOT="${E2E_SHOT:-1}" TOPICS_E2E_BUNDLE_DIR="$BUNDLE" "$REPO_ROOT/scripts/e2e-shards.sh" "$SHARDS" "${SEL[@]}"
  rc=$?
  RAN=1
  since "$t"
else
  step "suite saltata (SKIP_E2E=1): si pubblica il report già su disco"
fi

# SI RIFONDE SOLO SE LA SUITE HA GIRATO ADESSO.
#
# $OUT_DIR non si svuota fra le corse, quindi con SKIP_E2E=1 rifondere significa prendere per
# buoni i report di QUALUNQUE cosa ci sia rimasta dentro. E' successo: una verifica su 4 file ha
# lasciato li' i suoi report, la ripubblicazione li ha fusi, e la pagina e' passata da 125
# requisiti verdi a 3 — senza che niente fallisse. «Pubblica quel che c'e' su disco» vuol dire
# il report gia' fuso, non i pezzi di una corsa che non era questa.
if [ "$RAN" = "1" ]; then
  step "fusione dei report di shard"
  bun run scripts/merge-shard-reports.ts "$OUT_DIR" --out "$MERGED" || {
    echo "✗ senza un report fuso la pagina direbbe 'mai eseguito' per metà suite. Fermo qui." >&2
    exit 1
  }
else
  step "report già fuso (SKIP_E2E=1: NON si rifonde)"
  [ -f "$MERGED" ] || { echo "✗ manca $MERGED e la suite non ha girato: non c'è niente da pubblicare." >&2; exit 1; }
  echo "  $MERGED — $(date -r "$MERGED" '+%d %b %H:%M')"
fi

# Il piano degli shard si bilancia su queste durate. Ri-registrarle dopo OGNI corsa con
# evidenza e' cio' che tiene gli shard a finire insieme invece di aspettarne uno: i pesi presi
# col video sovrastimano una corsa col solo trace, e non in modo uniforme.
if [ "$RAN" = "1" ]; then
  step "durate per il piano degli shard"
  bun run scripts/e2e-record-durations.ts "$OUT_DIR"/report-*.json || true
fi

# ORDINE: la mappa di copertura viene PRIMA dell'indice, perche' `--by-file` la legge per
# sapere quali file e2e dichiarano un requisito senza prova per-test. Al contrario userebbe la
# mappa della corsa precedente — e alla primissima corsa non ne troverebbe nessuna.
# La suite unitaria e' l'unica prova che 583 requisiti su 742 abbiano MAI girato: il report
# Playwright non la contiene, e senza questo passo la pagina li chiama tutti «non eseguito qui».
# Non blocca: un rosso unitario e' un'informazione da pubblicare, non un motivo per non pubblicare.
if [ "${SKIP_UNIT:-0}" = "1" ]; then
  step "suite unitaria — SALTATA, si riusa $JUNIT"
  test -f "$JUNIT" || echo "  ⚠ non c'è: gli esiti unitari mancheranno dalla pagina."
else
  step "suite unitaria (per gli esiti che il report Playwright non contiene)"
  t=$(date +%s)
  mkdir -p "$OUT_DIR"   # con SKIP_E2E=1 nessuno lo ha creato, e il log finirebbe nel nulla
  bun test --timeout "${TOPICS_TEST_TIMEOUT_MS:-30000}" --reporter=junit --reporter-outfile="$JUNIT" \
    ./client/src ./server/ ./shared ./relay ./tests/unit ./tests/integration ./scripts ./cli \
    > "$OUT_DIR/unit.log" 2>&1
  unit=$?
  since "$t"
  [ "$unit" -ne 0 ] && echo "  ⚠ la suite unitaria ha dei rossi (log: $OUT_DIR/unit.log): la pagina li mostrerà."
fi

step "mappa di copertura (dal cancello che possiede le regole)"
t=$(date +%s)
# Due sorgenti di esito PER FILE: JUnit per i runner non-browser, il report Playwright per i file
# e2e dichiarati con @covers. Senza la seconda, 43 requisiti di topics-app restavano grigi anche
# dopo la suite intera: il loro esito per-requisito nascerebbe dalle annotazioni, che non hanno.
bun run scripts/check-spec-coverage.ts --json "$MAP" --junit "$JUNIT" --pw-report "$MERGED"
gate=$?
since "$t"
[ "$gate" -ne 0 ] && echo "  ⚠ il cancello di tracciabilità è rosso: la mappa è comunque scritta, ma guardalo."

step "evidenza per requisito (e SOLO quella: il resto non e' raggiungibile dalla pagina)"
# La cartella si svuota SOLO se la suite ha girato: i collegamenti sono duri e restano, quindi
# senza svuotare si continuerebbe a caricare l'evidenza delle corse vecchie per sempre — ma
# svuotarla con SKIP_E2E=1 butterebbe l'unica evidenza che c'e'.
if [ "$RAN" = "1" ]; then
  find videos -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
fi
bun run scripts/build-uat-index.ts --report "$MERGED" --by-requirement --by-file --only-requirements || exit 1
EVID=$(find videos -type f \( -name '*.webm' -o -name '*.zip' \) | wc -l | tr -d ' ')
echo "  videos/: $EVID file, $(du -sh videos 2>/dev/null | cut -f1)"

# NON SI PUBBLICA UNA PAGINA SENZA EVIDENZA DOPO UNA CORSA CHE DOVEVA PRODURNE.
#
# E' successo, ed e' il motivo per cui queste righe esistono: gli shard sono morti nel setup
# (bundle piu' vecchio dei sorgenti), la catena e' arrivata in fondo lo stesso e ha sostituito
# una living-doc con 121 prove con una che non ne aveva nessuna. Un rosso nei test si pubblica,
# e' la verita'. Una suite che non ha girato non e' una verita' su niente.
if [ "$RAN" = "1" ] && [ "$EVID" -eq 0 ]; then
  echo >&2
  echo "✗ la suite ha girato e non ha prodotto NEMMENO UNA prova pubblicabile." >&2
  echo "  Non si pubblica: sostituirebbe con il nulla l'evidenza che c'e' online." >&2
  echo "  Guarda $OUT_DIR/shard-*.log — quasi sempre e' il setup, non i test." >&2
  exit 1
fi

step "cancello openspec"
bun --bun spec-flow/scripts/lint-openspec.ts || {
  echo "✗ pubblicare adesso sovrascriverebbe la living-doc con qualcosa di sbagliato." >&2
  exit 1
}

[ "$rc" -ne 0 ] && echo && echo "⚠ la suite ha dei rossi: si pubblica lo stesso, la pagina li mostrerà."

step "pubblicazione"
t=$(date +%s)
bun --bun spec-flow/scripts/publish-uat.ts
pub=$?
since "$t"
exit "$pub"
