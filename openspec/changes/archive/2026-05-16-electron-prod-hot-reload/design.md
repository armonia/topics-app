## Context

Topics App runs as a web app served by Bun on port 3333. The Electron shell (`electron-app/`) exists with multi-window support (topic detach, browser tabs, system tray) but is only used in development via `DEV_URL=http://localhost:5173`. Production uses a macOS LaunchAgent (`com.armoria.topics-prod`) that runs `scripts/start-prod.sh` — a bash script that builds the client with Vite, watches for changes via `fswatch`, and runs the server with `bun --watch`. When client assets rebuild in production, users must manually refresh the browser.

The Electron main process (`main.js`) already handles: main window creation, detached topic windows (`detachedWindows` Map), browser tabs via BrowserView, system tray, CDP on port 19333/19334, and IPC handlers. It reads `SERVER_URL` from `DEV_URL` env or defaults to `http://localhost:3333`.

## Goals / Non-Goals

**Goals:**
- Automatic client reload in production Electron when `/public/` assets change after rebuild
- Electron-first production deployment: LaunchAgent starts Electron, which manages its lifecycle alongside the server
- Packaged `.app` works in production mode (loads from localhost:3333, no DEV_URL needed)
- Multi-window features (topic detach, browser tabs) verified working in production context

**Non-Goals:**
- HMR in production (full page reload is fine — HMR is dev-only via Vite)
- Auto-updating Electron via electron-updater (manual rebuild for now)
- Changing the server architecture or moving away from Bun
- Running server inside Electron process (server stays as separate Bun process)

## Decisions

### D1: File watcher for `/public/` triggers reload via `fs.watch`

Use Node's built-in `fs.watch` (available in Electron's main process) to watch the `/public/` directory for changes. When a change is detected, debounce for 500ms (to let Vite finish writing all chunks), then reload all BrowserWindows.

**Why not chokidar?** Extra dependency. `fs.watch` is sufficient for watching a single directory for rebuild events. We're not tracking individual files — just detecting "something changed in /public/".

**Why not fswatch IPC?** Would require the bash script to signal Electron. Simpler to watch directly from the main process.

### D2: Reload all windows (main + detached) on asset change

When `/public/` changes, call `webContents.reload()` on mainWindow and all entries in `detachedWindows`. BrowserViews (browser tabs) are NOT reloaded — they point to external URLs, not the app.

**Why reload all?** Shared CSS and JS bundles mean a partial reload would leave windows out of sync. Full reload is cheap (local server, <1s).

### D3: Two-process production architecture (Electron + Server)

Keep server as a separate Bun process managed by the same LaunchAgent or a companion script. Electron launches via a new `scripts/start-electron-prod.sh` that:
1. Ensures the server is running (check port 3333)
2. Launches Electron with `NODE_ENV=production`

**Why not embed server in Electron?** Bun's `--watch` and the existing server architecture depend on running as a standalone Bun process. Embedding would require major refactoring with no clear benefit. The web UI must also remain accessible via browser for non-Electron users.

### D4: LaunchAgent runs start-prod.sh (server) + Electron separately

Update the LaunchAgent to run both the server script and Electron. Two approaches:
- **Option A**: Single script that starts server in background, then launches Electron
- **Option B**: Two LaunchAgents

**Chosen: Option A** — simpler to manage, single plist. The script starts the server (backgrounded), waits for port 3333, then execs Electron.

### D5: electron-builder config for production

Update `electron-app/package.json` build config to:
- Set `asar: true` for packaging
- Include `main.js` and `preload.js` in the bundle
- The app connects to `localhost:3333` by default (no embedded server)
- Sign with existing developer identity if available

## Risks / Trade-offs

- **[fs.watch reliability on macOS]** → macOS `fs.watch` uses FSEvents which is reliable. Debounce handles multiple rapid events.
- **[Server not ready on Electron launch]** → Wait loop with health check (retry GET to `localhost:3333` up to 30s) before creating window.
- **[Detached windows lose state on reload]** → State is server-side (topic ID in URL). Reload preserves the topic context. Scroll position may reset — acceptable trade-off.
- **[LaunchAgent complexity]** → Single script approach keeps it simple. If Electron crashes, KeepAlive restarts the whole script (server check is idempotent).

## Open Questions

- Should we add a visual indicator in the Electron title bar when a reload happens (e.g., brief flash or notification)?
- Do we want a "Restart Server" menu item in the Electron app menu for debugging?
