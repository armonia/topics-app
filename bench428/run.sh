#!/usr/bin/env bash
# run.sh KIND "VARIANTS" N: for each variant, apply its patches to the head, run
# one test file N times under a 2 GB / 120 s cap, write one row per run, then put
# the sources back. A variant is "fixed" (no patch) or patch names joined by "+"
# (cr-<name>.patch / jc-<name>.patch); a "@old" suffix runs the jcode file as it
# was on main before this PR (spies on reads only).
set -u
kind=$1 variants=$2 n=$3
if [[ $kind == cr ]]; then
  file=./client/src/components/Chat/commandRisk.test.ts src=client/src/components/Chat/commandRisk.ts
else
  file=./server/lib/external-jcode-sessions.test.ts src=server/lib/external-jcode-sessions.ts
fi
mkdir -p out
for v in $variants; do
  name=${v%@old}
  if [[ $name != fixed ]]; then
    for p in ${name//+/ }; do
      git apply "bench428/patches/$kind-$p.patch" || { echo "patch $kind-$p does not apply"; exit 2; }
    done
  fi
  [[ $v == *@old ]] && cp bench428/old/external-jcode-sessions.test.ts "$file"
  tag=$kind-$v; tag=${tag//@/-}; tag=${tag//+/_}
  rows=out/runs-$tag-${SHARD:-0}.tsv; : > "$rows"
  for ((i = 1; i <= n; i++)); do
    ld=$(cut -d' ' -f1 /proc/loadavg); t0=$EPOCHREALTIME
    log=$(python3 bench428/capped.py 2048 120 -- bun test --timeout 30000 "$file" 2>&1); rc=$?
    dt=$(awk -v a="$t0" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.2f", b - a }')
    np=$(grep -oE '^ [0-9]+ pass' <<<"$log" | grep -oE '[0-9]+'); nf=$(grep -oE '^ [0-9]+ fail' <<<"$log" | grep -oE '[0-9]+')
    nl=$(grep -c 'NOT LINEAR' <<<"$log")
    msg=$(grep -m1 -E 'Received: |^\+ |^\[capped\] killed|error:' <<<"$log" | cut -c1-220 | tr '\t' ' ')
    peak=$(grep -oE '^\[capped\] (peak|killed: footprint) [0-9]+' <<<"$log" | grep -oE '[0-9]+$')
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$v" "ci${SHARD:-0}" "$i" "$rc" "$dt" "$ld" "${np:-0}" "${nf:-0}" "$nl" "$msg|$peak" >> "$rows"
    grep "^RATIO" <<<"$log" | sed "s/^/$i\t/" >> "out/ratios-$tag-${SHARD:-0}.tsv"
    res=$([[ $rc == 0 ]] && echo green || echo red)
    [[ -f out/log-$tag-$res.txt ]] || printf '%s\n' "$log" | tail -80 > "out/log-$tag-$res.txt"
  done
  awk -F'\t' -v k="$kind $v" '{ n++; if ($5 == 0) g++; if ($10 > 0) l++ } END { printf "%s: %d runs, %d green, %d red, %d with NOT LINEAR\n", k, n, g, n - g, l }' "$rows" | tee -a "$GITHUB_STEP_SUMMARY"
  git checkout -- "$src" "$file"
done
