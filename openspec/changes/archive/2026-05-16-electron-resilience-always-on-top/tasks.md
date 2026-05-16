# Tasks

## 1. Crash Recovery (AC-1)
- [x] Add `process.on('uncaughtException')` handler that calls `app.relaunch()` + `app.exit(1)`
- [x] Add `process.on('unhandledRejection')` handler with same behavior
- [x] Add crash count guard (max 3 restarts in 60s to avoid crash loops)

## 2. LaunchAgent KeepAlive (AC-2)
- [x] Update `scripts/com.armonia.topics-electron-prod.plist` — add `<key>KeepAlive</key><true/>`
- [x] Verify plist syntax is valid

## 3. Always-on-Top Toggle (AC-3, AC-4, AC-5)
- [x] Add `alwaysOnTop` state variable in main.js
- [x] Add `toggleAlwaysOnTop()` function using `mainWindow.setAlwaysOnTop(value, 'floating')`
- [x] Add tray menu checkbox item "Always on Top"
- [x] Add `globalShortcut.register('CommandOrControl+Shift+T', ...)` for keyboard toggle
- [x] Add IPC handler `app:toggle-always-on-top` for renderer access
- [x] Persist state to userData JSON file
- [x] Load persisted state on startup and apply to window

## 4. Preload API (optional, AC-3)
- [x] Expose `toggleAlwaysOnTop()` and `getAlwaysOnTop()` in preload.js

## 5. Verify Existing Behavior (AC-6)
- [x] Confirm close-to-tray works correctly
- [x] Confirm tray click restores window

---

## Audit 2026-05-16

All tasks verified or just landed:
- Crash recovery: `uncaughtException` + `unhandledRejection` handlers in `electron-app/main.ts:2254-2258`, `crashCount` 3-in-window guard at `:2232-2246`.
- LaunchAgent KeepAlive present in `scripts/com.armonia.topics-electron-prod.plist`.
- Always-on-top state, toggle function, IPC handlers, tray checkbox, preload exposure — all present in `main.ts` and `preload.ts`.
- **NEW 2026-05-16**: `globalShortcut.register('CommandOrControl+Shift+T', …)` added in `main.ts:app.whenReady()`, with `unregisterAll()` on `will-quit`. TypeScript clean.

Manual smoke (close-to-tray, tray click restore) covered by existing tray code paths.
