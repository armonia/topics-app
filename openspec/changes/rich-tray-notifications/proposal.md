## Why

The Electron app currently has a minimal tray icon (static image, basic tooltip with unread count, simple show/hide/quit menu). It polls `/api/unread` every 5s but only updates the dock badge and tooltip — no native macOS notifications, no gateway status visibility, no agent session info, no rich context menu. Users have no way to see what's happening without opening the window. The app should be a proper tray-resident desktop app: always running, instantly accessible, with real-time status and notifications.

## What Changes

- **Rich tray context menu**: Dynamic menu rebuilt on state changes showing gateway status (connected/disconnected), active agent sessions, top topics with unread counts, and quick actions (mark all read, new topic, open specific topic).
- **Native macOS notifications**: Use Electron's `Notification` API from the main process to show native notifications for new messages, agent completions, approval requests. Click notification to focus the relevant topic window. Retain notification references to avoid GC issues.
- **Dynamic tray icon**: Swap tray icon between states (normal, unread, disconnected) using pre-rendered template PNGs. Use `tray.setTitle('N')` for unread count display next to icon.
- **WebSocket connection from main process**: Replace the 5s HTTP polling with a direct WebSocket connection from Electron main process to `ws://localhost:3333/ws`. This gives real-time updates for unread counts, gateway status, agent sessions, and message events — enabling instant notifications.
- **Auto-start at login**: Use `app.setLoginItemSettings({ openAtLogin: true })` for the Electron app. The Bun server continues via its own LaunchAgent.

## Capabilities

### New Capabilities
- `tray-status-menu`: Rich dynamic tray context menu showing system status, active agents, unread topics, and quick actions.
- `native-notifications`: macOS native notifications for messages, agent events, approvals with click-to-focus and notification lifecycle management.
- `tray-ws-bridge`: WebSocket client in Electron main process for real-time server updates (replaces HTTP polling).

### Modified Capabilities

## Impact

- **electron-app/main.js**: Major additions — WS client, notification system, dynamic tray menu rebuilding, icon swapping.
- **electron-app/preload.js**: New IPC for notification preferences (mute/unmute per topic).
- **electron-app/assets/**: New tray icon variants (normal, unread, disconnected template PNGs).
- **server/routes/topics.ts**: May need a lightweight endpoint for last message preview per topic (for notification body text).
- **No client-side changes needed** — all tray/notification logic lives in Electron main process.
