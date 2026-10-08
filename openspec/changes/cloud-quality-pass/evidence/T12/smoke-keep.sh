#!/usr/bin/env bash
# Same as `build-server-sidecar.sh smoke`, but keeps the binary's log and reports schema facts.
# Usage: smoke-keep.sh <worktree> <bun-bin-dir-or-empty> <label>
set -u
W=$1; BD=$2; LABEL=$3
SP=/tmp/claude-0/-home-user-topics-app/affbdc18-0dbd-502d-80eb-3382b653a1e1/scratchpad
[ -n "$BD" ] && export PATH=$BD:$PATH
cd $W
WORK=$(mktemp -d); BIN=$WORK/bin; PORT=13465; SOCK=/tmp/smk-$$.sock
bun --version
bun build --compile --target=bun-linux-x64 --external playwright-core --external chromium-bidi --external electron ./server/sidecar-entry.ts --outfile $BIN >/dev/null 2>&1 || { echo compile-failed; exit 1; }
NO_TLS=1 BUN_PORT=$PORT SERVER_HOST=127.0.0.1 TOPICS_DATA_DIR=$WORK/data DATA_DIR=$WORK/data/data TOPICS_HOME=$WORK/home \
  TOPICS_PTY_SOCKET=$SOCK TOPICS_DISABLE_PTY_BRIDGE=1 TOPICS_EMBEDDED=1 HOME=$WORK/fakehome $BIN > $SP/smoke-$LABEL.log 2>&1 &
P=$!
for _ in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:$PORT/api/topics && break; sleep 0.25; done
echo "api/topics $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/topics)"
sleep 1
kill $P; wait $P 2>/dev/null
grep -E "embedded migration|All migrations|syntax error|Migration .* failed|SQLiteError" $SP/smoke-$LABEL.log | head -3
DB=$(find $WORK/data -name "*.db" | head -1); echo "db=$DB"
[ -n "$DB" ] && bun -e "const {Database}=require('bun:sqlite');const d=new Database('$DB');console.log('schema_migrations', d.query('SELECT COUNT(*) n FROM schema_migrations').get().n)"
rm -rf $WORK $SOCK
