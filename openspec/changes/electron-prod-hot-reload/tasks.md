## 1. Auto-Reload Watcher in Electron

- [x] 1.1 Add `fs.watch` on `/public/` directory in `electron-app/main.js` — start watcher after `app.whenReady()`, debounce 500ms
- [x] 1.2 Implement reload logic: on debounced change, call `webContents.reload()` on `mainWindow` and all `detachedWindows` entries
- [x] 1.3 Exclude `BrowserView` instances (browser tabs) from reload — only reload app windows
- [x] 1.4 Add watcher cleanup in `app.on('will-quit')` handler
- [x] 1.5 Add console logging for reload events: `[Topics Electron] Asset change detected, reloading...`

## 2. Production Startup Script

- [x] 2.1 Create `scripts/start-electron-prod.sh` — starts Bun server in background, waits for port 3333 (health check loop, 30s timeout), then launches Electron
- [x] 2.2 Update `scripts/start-prod.sh` to be server-only (remove any browser assumptions, keep fswatch + bun --watch)
- [x] 2.3 Add `NODE_ENV=production` to Electron launch in the new script

## 3. LaunchAgent Update

- [x] 3.1 Create updated LaunchAgent plist (`com.armonia.topics-electron-prod`) that runs `start-electron-prod.sh` with KeepAlive and proper env vars
- [x] 3.2 Document how to switch from old `com.armonia.topics-prod` to new Electron-first LaunchAgent

## 4. Electron Build Config

- [x] 4.1 Verify `electron-app/package.json` build config produces working `.app` bundle that defaults to `localhost:3333`
- [x] 4.2 Ensure `main.js` and `preload.js` are included in asar bundle
- [x] 4.3 Test packaged app launches and connects without `DEV_URL`

## 5. Multi-Window Production Verification

- [x] 5.1 Verify detached topic windows work when loaded from production server (port 3333)
- [x] 5.2 Verify browser tabs panel (BrowserView) positioning and switching in production Electron
- [x] 5.3 Verify layout persistence survives auto-reload (layout restored from server after reload)
- [x] 5.4 Verify system tray and CDP ports function in production mode
