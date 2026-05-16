# Electron Resilience & Always-on-Top

## What
Make the Topics Electron app a persistent, always-available desktop companion:
1. **Auto-restart on crash/force-quit** — if the process dies unexpectedly, it relaunches automatically
2. **Tray persistence** — already implemented (hide on close), ensure it's solid
3. **Always-on-top toggle** — user can pin the window above all other windows via tray menu and keyboard shortcut

## Why
Topics is a productivity companion that should always be reachable. If the app crashes or gets killed, the user shouldn't have to manually relaunch. The always-on-top option is essential for keeping Topics visible while working in other apps (e.g., coding in an IDE with Topics pinned for chat context).

## Scope
- Electron main process only (`electron-app/main.js`)
- LaunchAgent plist update for crash recovery (`scripts/`)
- No server or client changes needed

## Out of Scope
- Server process resilience (handled separately by LaunchAgent)
- Windows/Linux support (macOS only for now)
