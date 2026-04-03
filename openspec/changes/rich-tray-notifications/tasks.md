## 1. Tray Icon Assets

- [x] 1.1 Create `trayTemplate.png` and `trayTemplate@2x.png` — normal state (black+alpha template image, 16x16 / 32x32)
- [x] 1.2 Create `trayUnreadTemplate.png` and `trayUnreadTemplate@2x.png` — filled dot variant for unread state
- [x] 1.3 Create `trayDisconnectedTemplate.png` and `trayDisconnectedTemplate@2x.png` — hollow/crossed variant for disconnected state

## 2. WebSocket Bridge in Main Process

- [x] 2.1 Add `ws` npm package to `electron-app/package.json` dependencies
- [x] 2.2 Implement `TrayWSBridge` class in `electron-app/main.js` — connects to `ws://localhost:3333/ws`, parses messages, emits events
- [x] 2.3 Add exponential backoff reconnection (1s to 30s max) with auto-reconnect on drop
- [x] 2.4 Handle `connected`, `unread:init`, `unread:updated`, `gateway:status`, `agents:sessions`, `message` event types
- [x] 2.5 Add topic cache — fetch `GET /api/topics` on WS connect, refresh every 60s, fallback for unknown topic IDs
- [x] 2.6 Remove old HTTP polling (`startUnreadPolling`, `fetchUnreadCount`, `unreadTimer`) — replaced by WS

## 3. Dynamic Tray Menu

- [x] 3.1 Implement `rebuildTrayMenu()` — builds menu from current state (gateway, agents, unread topics, actions)
- [x] 3.2 Add gateway status item (connected/disconnected) as non-clickable label
- [x] 3.3 Add active agent count item
- [x] 3.4 Add unread topics section — up to 10 topics, click to focus main window + navigate to topic
- [x] 3.5 Add "Mark All Read" action — calls POST /api/topics/:id/read for each unread topic
- [x] 3.6 Debounce menu rebuilds to max 1 per second
- [x] 3.7 Wire WS events (unread:updated, gateway:status, agents:sessions) to trigger menu rebuild

## 4. Dynamic Tray Icon

- [x] 4.1 Implement `updateTrayIcon()` — swaps icon based on state priority (unread > disconnected > normal)
- [x] 4.2 Use `tray.setTitle(count, { fontType: 'monospacedDigit' })` for unread count display
- [x] 4.3 Clear title when all read
- [x] 4.4 Wire state changes to icon updates

## 5. Native Notifications

- [x] 5.1 Implement `NotificationManager` — stores active notifications in Map, handles lifecycle (retain refs, cleanup on click/close, 5-min sweep)
- [x] 5.2 Add message notification trigger — on message WS event, show notification if window hidden or different topic focused
- [x] 5.3 Add per-topic rate limiting (max 1 notification per topic per 10s)
- [x] 5.4 Add agent completion notification trigger
- [x] 5.5 Add approval request notification trigger
- [x] 5.6 Add gateway status change notifications (disconnect/reconnect)
- [x] 5.7 Implement click-to-focus — on notification click, show+focus main window and navigate to topic

## 6. IPC for Topic Navigation

- [x] 6.1 Add `navigate-to-topic` IPC event handler in preload.js
- [x] 6.2 Add client-side listener in React app — receives navigate-to-topic and switches active topic

## 7. Auto-Start and Cleanup

- [x] 7.1 Enable `app.setLoginItemSettings({ openAtLogin: true })` on first launch
- [x] 7.2 Ensure WS connection closes cleanly on will-quit
- [x] 7.3 Ensure notification cleanup runs on will-quit
