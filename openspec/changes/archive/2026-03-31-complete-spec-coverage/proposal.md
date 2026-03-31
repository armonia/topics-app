## Why

The current 10 OpenSpec specs cover ~60-65% of the app's feature surface. A comprehensive audit comparing specs against the actual codebase (102 components, 25+ API routes, 28 hooks) revealed 20 feature areas with no spec coverage — including major user-facing features like the embedded browser, cron job management, system monitoring, and remote access tunneling. Without specs, these features have no acceptance criteria, no traceability to tests, and no coverage tracking.

## What Changes

- Create 4 new specs for entirely uncovered feature domains (remote browser, cron jobs, system status, remote access)
- Extend 6 existing specs with missing requirements for features already partially covered (activity feed details, journal, process runner, advanced git, checkpoints, push notifications)
- Create 4 additional specs for supporting systems (webhooks, notifications, processes, spaces)
- Extend 4 existing specs with missing sub-feature requirements (agent profiles CRUD, board memory tags, topic agent assignment, extended approvals)

## Capabilities

### New Capabilities
- `remote-browser`: Embedded Chromium browser with agent-driven web automation — navigation, click, type, scroll, screenshot, accessibility tree, cookie persistence, multi-context
- `cron-jobs`: Scheduled job management — CRUD, schedule types (at/every/cron), timezone support, execute now, enable/disable, payload types (systemEvent/agentTurn)
- `system-status`: Real-time server health monitoring — gateway status/latency, uptime, memory usage, active connections, cron status, restart gateway action
- `remote-access`: Secure external access via tunnel providers — Tailscale Funnel, Cloudflare Tunnel, LocalTunnel, ngrok — status check, toggle, public URL copy, expiry display
- `webhooks`: Incoming webhook management — CRUD, test delivery, trigger configuration
- `processes`: Script/process execution — list from package.json, start/stop, live log streaming, process status
- `spaces`: Project/space organizational structure — higher-level grouping above topics

### Modified Capabilities
- `dashboard`: Add DASH-02 (Activity Feed real-time with Live/Digest tabs, SSE events, filtering) and DASH-03 (Journal/Digest with date navigation, summary text, events list)
- `files`: Add FILE-03 (Process/Script runner with live logs) and extend FILE-02 with advanced git (branch management, remote add/remove)
- `chat`: Add CHAT-05 (Checkpoints — conversation snapshots, timeline view, restore capability)
- `commands`: Add CMD-02 (Push Notifications — VAPID keys, subscribe/unsubscribe, permission handling) and extend CMD-01 with UI state persistence details
- `agents`: Extend AGENT-01 with detailed profile CRUD (create, edit, delete forms) and AGENT-02 with topic-level assignment panel details
- `kanban`: Extend KANBAN-02 with board memory tags and extended approval workflow details (review modal, confidence scores, justification)

## Impact

- **Spec files**: 7 new specs created, 6 existing specs modified (delta files)
- **Coverage script**: No changes needed (regex already handles new heading format)
- **Test annotations**: Future phase — new tests will need annotations for new requirement IDs
- **No code changes**: This is a documentation-only change adding acceptance criteria
