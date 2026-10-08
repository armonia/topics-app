#!/usr/bin/env bash
# Alternated runs of bench-loop.sh: BASE, HEAD, BASE, HEAD. Usage: paired-loop.sh <head-dir> <tag> [N=20]
# Appends one JSON line per run to paired-loop-<tag>.log.
B=$(cd "$(dirname "$0")" && pwd)
HEADDIR=$1; TAG=$2; N=${3:-20}
LOG=$B/paired-loop-$TAG.log
: > "$LOG"
for round in 1 2; do
  for side in base head; do
    dir=$B/../base; [ $side = head ] && dir=$HEADDIR
    sleep 5
    bash "$B/bench-loop.sh" "$dir" "$TAG-$side-$round" "$N" >> "$LOG" 2>&1
  done
done
cat "$LOG"
