#!/bin/bash
# Start prod server with auto-reload for both server and client
cd /Users/user/.openclaw/workspace/topics-app

# Initial client build
(cd client && npx vite build 2>&1 | tail -3)

# Watch client/src for changes and rebuild (using fswatch)
(
  fswatch -r -e ".*" -i "\\.tsx$" -i "\\.ts$" -i "\\.css$" client/src/ | while read f; do
    echo "[$(date +%H:%M:%S)] Change detected: $f — rebuilding..."
    (cd client && npx vite build 2>&1 | tail -1)
  done
) &>/tmp/topics-client-watch.log &
WATCH_PID=$!

trap "kill $WATCH_PID 2>/dev/null" EXIT

# Start server with watch mode (ignore client/public to avoid restart on client rebuild)
exec /Users/user/.bun/bin/bun --watch --watch-ignore='public/**' --watch-ignore='client/**' --watch-ignore='uploads/**' run /Users/user/.openclaw/workspace/topics-app/server.ts
