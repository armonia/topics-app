#!/bin/bash
# Launch ONLY Electron (assumes server already running on :3333)
set -e
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export NODE_ENV=production

# Wait for server
TIMEOUT=15
ELAPSED=0
while ! curl -sfk https://127.0.0.1:3333 > /dev/null 2>&1; do
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

# Launch Electron binary directly (not via .bin/electron node wrapper)
# The node wrapper spawns Electron as a child, and Chromium re-execs creating
# an orphan process. Direct exec keeps launchd as the parent.
exec "$APP_DIR/electron-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$APP_DIR/electron-app"
