## Context

The Electron main process (`electron-app/main.js`) currently has:
- A static tray icon (`tray-icon.png`, 18x18) with tooltip showing unread count
- A basic context menu (Show Topics, Open at Login, Quit)
- HTTP polling every 5s to `GET /api/unread` for badge/tooltip updates
- Dock badge via `app.dock.setBadge(count)`

The server already provides everything needed via WebSocket (`ws://localhost:3333/ws`):
- `unread:init` + `unread:updated` — real-time unread counts per topic
- `gateway:status` — connected/disconnected boolean
- `agents:sessions` — active agent sessions with status
- `message` — new messages with content
- Push trigger events: `approval:created`, `agents:stopped`

The HTTP API also provides `GET /api/system/status` (gateway, server, connections, sessions) and `GET /api/topics` (topic list with names, colors, icons).

## Goals / Non-Goals

**Goals:**
- Replace HTTP polling with WebSocket for real-time tray updates
- Rich dynamic tray menu: gateway status, agent sessions, unread topics, quick actions
- Native macOS notifications for important events (new messages, agent completions, approvals)
- Click notification to focus the right window/topic
- Dynamic tray icon reflecting current state
- Auto-start at login via Electron API

**Non-Goals:**
- Notification preferences UI in the React client (future work)
- Sound customization (use default system sound)
- Windows/Linux tray support (macOS only for now)
- Notification grouping/stacking (use macOS default behavior)
- Inline reply from notification (complex, defer)

## Decisions

### D1: WebSocket from Electron main process (not renderer)

Connect to `ws://localhost:3333/ws` directly from the Node.js main process using the `ws` npm package (already available in Electron's Node context). This replaces the 5s HTTP polling entirely.

**Why not use the renderer's WS?** The tray/notifications live in the main process. IPC-bridging every event from renderer to main would be fragile and only works when the window is open. Direct WS gives the main process autonomous real-time updates even when the window is hidden.

**Reconnection**: Same exponential backoff strategy the client uses (1s to 30s max).

### D2: Rebuild tray menu on every state change

Electron's Tray API requires replacing the entire context menu — you can't update individual items. Build a `rebuildTrayMenu()` function that reads current state (gateway status, agent sessions, unread topics) and produces a fresh `Menu`.

**Menu structure:**
```
--- Gateway: Connected (checkmark) (or cross Disconnected)
--- Agents: 2 active
--- separator
--- Topic A (3 unread)          click opens topic
--- Topic B (1 unread)          click opens topic
--- ... (max 10 topics)
--- separator
--- Mark All Read
--- separator
--- Open at Login (checkbox)
--- Show Topics
--- Quit
```

**Trigger rebuilds on:** `unread:updated`, `gateway:status`, `agents:sessions` WS events.

### D3: Pre-rendered template PNGs for tray icon states

Three icon states:
- `trayTemplate.png` — normal (no unreads, gateway connected)
- `trayUnreadTemplate.png` — has unread messages (filled dot variant)
- `trayDisconnectedTemplate.png` — gateway disconnected (hollow/crossed variant)

Using template images ensures automatic light/dark mode adaptation. Swap via `tray.setImage()`.

Additionally, use `tray.setTitle(count)` with `fontType: 'monospacedDigit'` to show the unread count as text next to the icon.

### D4: Notification lifecycle with reference retention

Store active `Notification` instances in a `Map<string, Notification>` keyed by a notification ID (e.g., `msg-{topicId}-{timestamp}`). Remove on `click` or `close` events. Sweep stale entries every 5 minutes as safety net (macOS doesn't guarantee `close` fires for all dismissal types).

**Notification triggers:**
- New message (unread topic): Title = topic name, Body = first 100 chars of message, Click = focus topic
- Agent completed: Title = "Agent done", Body = agent name + topic, Click = focus topic
- Approval needed: Title = "Approval needed", Body = tool name + topic, Click = focus topic
- Gateway disconnected: Title = "OpenClaw offline", Body = "Gateway connection lost", Click = focus main
- Gateway reconnected: Title = "OpenClaw online", Body = "Gateway connection restored"

**Rate limiting:** Max 1 notification per topic per 10 seconds to avoid spam during active conversations.

### D5: Topic data fetched once, updated incrementally

On WS connect, fetch `GET /api/topics` to get topic names/colors for the tray menu and notification titles. Cache in a Map. Re-fetch periodically (every 60s).

### D6: Auto-start via `app.setLoginItemSettings`

Use Electron's built-in API rather than managing a separate LaunchAgent for the Electron app. The Bun server still uses its own LaunchAgent. The "Open at Login" checkbox in tray menu and app menu already calls `app.setLoginItemSettings` — just ensure it's enabled by default on first launch.

## Risks / Trade-offs

- **[WS connection from main process adds dependency on `ws` package]** — The `ws` npm package is lightweight (no native deps). Only needed because main process doesn't have browser WebSocket API.
- **[Tray menu rebuild frequency]** — During active conversations, `unread:updated` fires frequently. Debounce menu rebuilds to max once per second.
- **[Notification spam during active chat]** — Per-topic rate limiting (10s cooldown) prevents flooding. Also skip notifications for the currently active/focused topic.
- **[Gateway offline false positives]** — The server's health check already debounces this (30s interval). Trust the `gateway:status` WS event.
