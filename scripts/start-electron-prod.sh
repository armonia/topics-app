#!/bin/bash
# Electron-first production startup
# Starts the Bun server + client watcher, waits for it to be ready, then launches Electron
set -e

APP_DIR="/Users/user/.openclaw/workspace/topics-app"
LOCKFILE="/tmp/topics-electron-prod.lock"
cd "$APP_DIR"

# --- Single-instance guard using flock ---
# macOS doesn't have flock, so use a PID-based approach with atomic check
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "$$" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[start-electron-prod] Already running (PID $OLD_PID). Exiting."
    exit 0
  fi
  # Stale lockfile, clean up
  rm -f "$LOCKFILE"
fi

# Write our PID atomically
echo $$ > "$LOCKFILE"

# Verify we won the race
sleep 0.2
WINNER=$(cat "$LOCKFILE" 2>/dev/null)
if [ "$WINNER" != "$$" ]; then
  echo "[start-electron-prod] Lost race to PID $WINNER. Exiting."
  exit 0
fi

export NODE_ENV=production

# Cleanup function
cleanup() {
  kill $SERVER_PID 2>/dev/null
  wait $SERVER_PID 2>/dev/null
  rm -f "$LOCKFILE"
}
trap cleanup EXIT

# --- Start server (with client watcher) in background ---
bash "$APP_DIR/scripts/start-prod.sh" &
SERVER_PID=$!

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
