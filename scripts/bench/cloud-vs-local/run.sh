#!/bin/sh
# Misura: riposo (60 s) → 4 card cloud → riposo → 4 card locali. Ogni fase col suo CSV.
# Uso: sh run.sh <cartella-risultati>
set -eu
out=${1:?uso: sh run.sh <cartella>}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"

phase() {  # phase <nome> <comando...>
  name=$1; shift
  "$@" > "$out/$name.out" 2>&1 &
  pid=$!
  python3 "$here/sample.py" "$pid" "$out/$name.csv" 3 &
  spid=$!
  wait "$pid" || echo "$name: uscito $?" >> "$out/errors.log"
  wait "$spid" || true
}

phase idle-1 sleep 60
phase cloud bun "$here/bench.ts" cloud "$out"
phase idle-2 sleep 60
phase local bun "$here/bench.ts" local "$out"
python3 "$here/summary.py" "$out" > "$out/summary.txt"
cat "$out/summary.txt"
# i worktree delle card locali non servono più
for w in "$out"/wt-*; do [ -d "$w" ] && git -C "$here" worktree remove --force "${w:?}" || true; done
