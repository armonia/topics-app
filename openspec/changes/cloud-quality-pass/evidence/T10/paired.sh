#!/usr/bin/env bash
# Alternate BASE / HEAD runs of the T10 bench, a fresh server each time.
set -u
S=/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad
OUT=${1:-$S/bench/runs}
mkdir -p $OUT
i=0
for tag in BASE-1 HEAD-1 BASE-2 HEAD-2; do
  i=$((i+1))
  case $tag in BASE*) repo=$S/base ;; *) repo=/home/user/topics-app ;; esac
  echo "== $tag $(uptime)"
  (cd $repo && bun run $S/bench/bench.ts $repo $((15400+i)) $OUT/$tag.json > $OUT/$tag.log 2>&1) || echo "$tag FAILED"
  tail -28 $OUT/$tag.log | grep -E '"p50"|"p95"|list_p|raw|gzip|keys' | tr -d ' \n'; echo
done
