export PATH=/opt/node20/bin:$PATH
cd /home/user/topics-app
S=/tmp/claude-0/-home-user-topics-app/2b119615-6f17-574c-b329-77893cf501ff/scratchpad
t() { local n=$1; shift; local s=$(date +%s); "$@" > $S/dopo-$n.log 2>&1; echo "$n EXIT=$? secs=$(( $(date +%s)-s )) $(uptime)"; }
t veloce ./scripts/qa-gate.sh --veloce
t unit bun run test:unit:shards
t build bun run build:client
t bundle bun run check:bundle
