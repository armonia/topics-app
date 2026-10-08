#!/usr/bin/env bash
# B1 of T10b: the targeted files, then the whole server unit suite, with one Bun.
# usage: b1.sh <repoRoot> <bunBinary> <outDir> <tag>
set -u
REPO=$1; BUN=$2; OUT=$3; TAG=$4
mkdir -p "$OUT"
cd "$REPO" || exit 9
V=$("$BUN" --version)
echo "== $TAG bun $V $(uptime)" | tee "$OUT/$TAG.summary"
for f in server/services/tasks.test.ts server/lib/wide-rows.test.ts server/lib/code-points.test.ts tests/unit/board-feed-fields.test.ts tests/integration/board-feed-lean.test.ts; do
  if [ ! -e "$f" ]; then echo "$f: ABSENT" | tee -a "$OUT/$TAG.summary"; continue; fi
  log="$OUT/$TAG.$(echo $f | tr / _).log"
  "$BUN" test --timeout 30000 "$f" > "$log" 2>&1; rc=$?
  echo "$f: exit $rc $(grep -E '^ *[0-9]+ (pass|fail)' "$log" | tr -s ' \n' ' ')" | tee -a "$OUT/$TAG.summary"
done
log="$OUT/$TAG.server-suite.log"
"$BUN" test --timeout 30000 server/ > "$log" 2>&1; rc=$?
echo "server/ suite: exit $rc $(grep -E '^ *[0-9]+ (pass|fail|skip|todo)' "$log" | tr -s ' \n' ' ')" | tee -a "$OUT/$TAG.summary"
grep -E '^\(fail\)' "$log" | sort -u > "$OUT/$TAG.server-suite.fails"
echo "server/ fails listed in $OUT/$TAG.server-suite.fails ($(wc -l < "$OUT/$TAG.server-suite.fails"))" | tee -a "$OUT/$TAG.summary"
