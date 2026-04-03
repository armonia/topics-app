# Technical Design

## 1. Auto-Restart on Crash/Force-Quit

### Approach A: Electron `app.relaunch()` on uncaught exception/unhandled rejection
- Listen for `process.on('uncaughtException')` and `process.on('unhandledRejection')`
- Call `app.relaunch()` then `app.exit(1)` to restart the app
- Handles in-process crashes

### Approach B: LaunchAgent KeepAlive
- Update the existing `com.armonia.topics-electron-prod.plist` to add `<key>KeepAlive</key><true/>` 
- macOS launchd will automatically restart the process if it exits for any reason
- Handles force-quit, kill -9, OOM kills, any exit
- This is the standard macOS pattern for persistent apps

### Chosen: Both A + B
- **A** gives fast in-process recovery for JS crashes (sub-second)
- **B** gives OS-level recovery for force-quit/kill (launchd restarts within seconds)
- They complement each other — A handles app-level errors, B handles everything else

## 2. Always-on-Top Toggle

### Implementation
- Add `alwaysOnTop` state tracked in main process
- `mainWindow.setAlwaysOnTop(true/false, 'floating')` — 'floating' level keeps it above normal windows but below system dialogs
- Expose via:
  - **Tray menu**: checkbox item "Always on Top"
  - **IPC handler**: `app:toggle-always-on-top` so the renderer can trigger it
  - **Global shortcut**: `Cmd+Shift+T` to toggle (registered via `globalShortcut`)
- Persist preference in Electron's `app.getPath('userData')` as simple JSON

### Window Level
Use `'floating'` level (not `'screen-saver'` or `'modal-panel'`) — this is the standard macOS behavior for "keep on top" that respects system UI like Spotlight and notification center.

## 3. Files Changed

| File | Change |
|------|--------|
| `electron-app/main.js` | Add crash recovery, always-on-top toggle, tray menu update, IPC handler, global shortcut |
| `scripts/com.armonia.topics-electron-prod.plist` | Add `KeepAlive` key |
| `electron-app/preload.js` | Expose `toggleAlwaysOnTop` / `getAlwaysOnTop` to renderer (optional) |
