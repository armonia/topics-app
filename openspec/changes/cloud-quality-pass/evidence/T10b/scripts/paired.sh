#!/usr/bin/env bash
# T10b B4: BASE (17a60e4) and T10b alternated, a fresh server per run, with ONE Bun.
# usage: paired.sh <bunBinDir> <label> <pairs> <outDir>
#   bunBinDir: the directory whose `bun` runs both the bench and the server (PATH first)
set -u
S=/tmp/claude-0/-home-user-topics-app/b31c7c56-3b0f-5998-b893-910039f80563/scratchpad
BIN=$1; LABEL=$2; PAIRS=$3; OUT=$4
mkdir -p "$OUT"
export PATH="$BIN:/opt/node20/bin:$PATH"
hash -r
V=$(bun --version)
port=15500
for i in $(seq 1 "$PAIRS"); do
  for side in BASE T10B; do
    port=$((port+1))
    case $side in BASE) repo=$S/base ;; T10B) repo=$S/head ;; esac
    tag="$LABEL-$side-$i"
    echo "== $tag bun $V $(uptime)"
    (cd "$repo" && TOPICS_GATE_SLOTS=0 bun run "$S/bench/bench.ts" "$repo" "$port" "$OUT/$tag.json" > "$OUT/$tag.log" 2>&1) || echo "$tag FAILED (see $OUT/$tag.log)"
    [ -f "$OUT/$tag.json" ] && bun -e "const r=require('$OUT/$tag.json'); const f=r.http['/api/all-boards/tasks']; console.log('$tag', 'bun', Bun.version, 'p50', f.p50, 'p95', f.p95, 'raw', r.bytes.raw, 'gzip', r.bytes.gzip, 'keys', r.keysPerTask, 'list_p50', r.inProcess.list_p50)"
  done
done
