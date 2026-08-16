#!/usr/bin/env bash
# Benchmark di concorrenza del runtime nativo: N turni veri in parallelo.
PID=$1; N=$2; D=/tmp/bench-out
mkdir -p "$D"
base=$(ps -o rss= -p "$PID" | tr -d ' ')
keys=()
for i in $(seq 1 "$N"); do
  t=$(curl -sk -X POST https://127.0.0.1:39470/api/topics -H 'content-type: application/json' -d "{\"name\":\"c$N-$i-$RANDOM\"}")
  keys+=("$(echo "$t" | python3 -c "import json,sys;print(json.load(sys.stdin)['sessionKey'])")")
done
start=$(date +%s.%N)
for k in "${keys[@]}"; do
  curl -sk -X POST https://127.0.0.1:39470/api/chat -H 'content-type: application/json' \
    -d "{\"sessionKey\":\"$k\",\"provider\":\"topics\",\"model\":\"claude-sonnet-4-6\",\"messages\":[{\"role\":\"user\",\"content\":\"Conta da 1 a 20, solo i numeri.\"}],\"contextMode\":\"full\"}" > "$D/${k//:/_}.txt" 2>&1 &
done
wait
end=$(date +%s.%N)
peak=$(ps -o rss= -p "$PID" | tr -d ' ')
ok=0
for k in "${keys[@]}"; do grep -q "DONE" "$D/${k//:/_}.txt" && ok=$((ok+1)); done
echo "$N $start $end $ok $base $peak" >> "$D/rows.txt"
awk -v n="$N" -v s="$start" -v e="$end" -v ok="$ok" -v b="$base" -v p="$peak" \
  'BEGIN{printf "N=%-3d wall %6.2fs  ok %d/%d  RSS %d->%d KB  %+.2f MB/sessione\n", n, e-s, ok, n, b, p, (p-b)/n/1024}'
