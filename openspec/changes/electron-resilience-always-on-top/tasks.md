# Tasks

## 1. Crash Recovery (AC-1)
- [ ] Add `process.on('uncaughtException')` handler that calls `app.relaunch()` + `app.exit(1)`
- [ ] Add `process.on('unhandledRejection')` handler with same behavior
- [ ] Add crash count guard (max 3 restarts in 60s to avoid crash loops)

## 2. LaunchAgent KeepAlive (AC-2)
- [ ] Update `scripts/com.armonia.topics-electron-prod.plist` — add `<key>KeepAlive</key><true/>`
- [ ] Verify plist syntax is valid

## 3. Always-on-Top Toggle (AC-3, AC-4, AC-5)
- [ ] Add `alwaysOnTop` state variable in main.js
- [ ] Add `toggleAlwaysOnTop()` function using `mainWindow.setAlwaysOnTop(value, 'floating')`
- [ ] Add tray menu checkbox item "Always on Top"
- [ ] Add `globalShortcut.register('CommandOrControl+Shift+T', ...)` for keyboard toggle
- [ ] Add IPC handler `app:toggle-always-on-top` for renderer access
- [ ] Persist state to userData JSON file
- [ ] Load persisted state on startup and apply to window

## 4. Preload API (optional, AC-3)
- [ ] Expose `toggleAlwaysOnTop()` and `getAlwaysOnTop()` in preload.js

## 5. Verify Existing Behavior (AC-6)
- [ ] Confirm close-to-tray works correctly
- [ ] Confirm tray click restores window
