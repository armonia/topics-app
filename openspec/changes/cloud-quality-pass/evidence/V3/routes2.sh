#!/usr/bin/env bash
# V3 B2 · T5 again: own port per side, and the previous server gone before the next starts.
until grep -q POST-DONE /tmp/v3/b2/ALL 2>/dev/null; do sleep 15; done
export PATH=/opt/node20/bin:$PATH SERVER_HOST=127.0.0.1
for i in 1 2 3; do for side in base head; do
  [ $side = base ] && port=13471 || port=13473
  for _ in $(seq 1 60); do curl -s -o /dev/null -m 1 http://127.0.0.1:$port/ || break; sleep 0.5; done
  echo "routes $side $i load=[$(cut -d' ' -f1-3 /proc/loadavg)] $(bun /tmp/v3/bench-routes.ts /home/user/v3-$side $side $port 2>&1 | tail -1)" >> /tmp/v3/b2/routes2.txt
  sleep 8
done; done
echo "routes2 DONE" >> /tmp/v3/b2/routes2.txt
