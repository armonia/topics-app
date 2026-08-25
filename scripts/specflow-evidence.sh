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
OUT_DIR="${TMPDIR:-/tmp}/topics-e2e-shards"
MERGED="test-results/uat-report.json"
MAP="openspec/coverage-map.json"

step() { echo; echo "▸ $*"; }
since() { echo "  ($(( $(date +%s) - $1 ))s)"; }

rc=0
if [ "$SKIP_E2E" != "1" ]; then
  step "suite E2E — $SHARDS shard, con video e trace"
  t=$(date +%s)
  E2E_EVIDENCE=1 "$REPO_ROOT/scripts/e2e-shards.sh" "$SHARDS"
  rc=$?
  since "$t"
else
  step "suite saltata (SKIP_E2E=1): si pubblica il report già su disco"
fi

step "fusione dei report di shard"
bun run scripts/merge-shard-reports.ts "$OUT_DIR" --out "$MERGED" || {
  echo "✗ senza un report fuso la pagina direbbe 'mai eseguito' per metà suite. Fermo qui." >&2
  exit 1
}

# La cartella si SVUOTA prima: i collegamenti sono duri e restano, quindi senza questo
# `publish-uat` continuerebbe a caricare l'evidenza delle corse precedenti per sempre.
step "evidenza per requisito (e SOLO quella: il resto non e' raggiungibile dalla pagina)"
find videos -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
bun run scripts/build-uat-index.ts --report "$MERGED" --by-requirement --only-requirements || exit 1
echo "  videos/: $(find videos -type f \( -name '*.webm' -o -name '*.zip' \) | wc -l | tr -d ' ') file, $(du -sh videos 2>/dev/null | cut -f1)"

step "mappa di copertura (dal cancello che possiede le regole)"
t=$(date +%s)
bun run scripts/check-spec-coverage.ts --json "$MAP"
gate=$?
since "$t"
[ "$gate" -ne 0 ] && echo "  ⚠ il cancello di tracciabilità è rosso: la mappa è comunque scritta, ma guardalo."

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
