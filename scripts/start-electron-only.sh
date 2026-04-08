#!/bin/bash
# Launch ONLY Electron (assumes server already running on :3333)
set -e
APP_DIR="/Users/user/.openclaw/workspace/topics-app"
cd "$APP_DIR"

export NODE_ENV=production

# Wait for server
TIMEOUT=15
ELAPSED=0
while ! curl -sf http://localhost:3333 > /dev/null 2>&1; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "[electron-only] Server not ready after ${TIMEOUT}s, launching anyway"
    break
  fi
done

# Build TS if needed
cd "$APP_DIR/electron-app" && npx tsc 2>/dev/null || true
cd "$APP_DIR"

exec "$APP_DIR/electron-app/node_modules/.bin/electron" "$APP_DIR/electron-app"
