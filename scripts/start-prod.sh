#!/bin/bash
# Start prod server with auto-reload for both server and client
cd /Users/user/.openclaw/workspace/topics-app

# Initial client build
(cd client && npx vite build 2>&1 | tail -3)

# Watch client/src for changes and rebuild (using fswatch)
# Runs in a self-restarting loop so it survives server restarts
(
  while true; do
    fswatch -r -e ".*" -i "\\.tsx$" -i "\\.ts$" -i "\\.css$" client/src/ | while read f; do
      echo "[$(date +%H:%M:%S)] Change detected: $f — rebuilding..."
      (cd client && npx vite build 2>&1 | tail -1)
    done
    echo "[$(date +%H:%M:%S)] fswatch exited, restarting in 2s..."
    sleep 2
  done
) &>/tmp/topics-client-watch.log &

# Start server with watch mode (ignore client/public to avoid restart on client rebuild)
# Use wait-based approach so the shell stays alive and can clean up children on exit
/Users/user/.bun/bin/bun --watch --watch-ignore='public/**' --watch-ignore='client/**' --watch-ignore='uploads/**' run /Users/user/.openclaw/workspace/topics-app/server.ts
