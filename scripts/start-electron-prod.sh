#!/bin/bash
# Electron-first production startup
# Starts the Bun server + client watcher, waits for it to be ready, then launches Electron
set -e

APP_DIR="/Users/user/.openclaw/workspace/topics-app"
cd "$APP_DIR"

export NODE_ENV=production

# --- Start server (with client watcher) in background ---
# Reuse start-prod.sh which handles server + client rebuild watching
bash "$APP_DIR/scripts/start-prod.sh" &
SERVER_PID=$!

# Cleanup: kill server when this script exits
trap "kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null" EXIT

# --- Wait for server to be ready ---
echo "[start-electron-prod] Waiting for server on port 3333..."
TIMEOUT=30
ELAPSED=0
while ! curl -sfk https://localhost:3333 > /dev/null 2>&1; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "[start-electron-prod] ERROR: Server did not start within ${TIMEOUT}s"
    exit 1
  fi
done
echo "[start-electron-prod] Server ready after ${ELAPSED}s"

# --- Build TypeScript ---
echo "[start-electron-prod] Building Electron TypeScript..."
cd "$APP_DIR/electron-app" && npx tsc
cd "$APP_DIR"

# --- Launch Electron ---
echo "[start-electron-prod] Starting Electron..."
exec "$APP_DIR/electron-app/node_modules/.bin/electron" "$APP_DIR/electron-app"
