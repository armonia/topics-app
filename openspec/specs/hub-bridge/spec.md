# hub-bridge Specification

## Purpose
Topics shows the usage hub (:3360) and switchboard (:3335) without copying their APIs: a proxy for requests and one server-side reader that pushes the live data on the Topics WebSocket. Plan: `~/.claude/jarvis/docs/hub-in-topics.md`, track 0.

## Requirements
### Requirement: HUBBR-01 — Proxy to the hub and to switchboard

The server SHALL forward `/api/hub/<rest>` to `<hub>/api/<rest>` and `/api/switchboard/<rest>` to `<switchboard>/api/<rest>`, query string included, forwarding only `content-type`, `accept` and `last-event-id`.

#### Scenario: A request reaches the configured host only
- **GIVEN** a path whose rest contains `%`, `//`, a leading `/` or a dot segment
- **WHEN** it reaches the bridge
- **THEN** the bridge SHALL answer 400 without any upstream request

#### Scenario: A failure never reads as data
- **GIVEN** the hub is down, slow past the headers timeout, or answers a redirect
- **WHEN** a panel asks through the bridge
- **THEN** the answer SHALL be 502 (down, redirect) or 504 (timeout) with the reason, never an empty 200

#### Scenario: No real hub under e2e
- **GIVEN** `TOPICS_E2E=1` and no `TOPICS_HUB_URL`
- **WHEN** a request reaches the bridge
- **THEN** it SHALL answer 503 and never call :3360

### Requirement: HUBBR-02 — Live hub data on the WebSocket

The server SHALL read `/api/pace`, `/api/mac`, `/api/services`, `/api/attesa`, `/api/alerts`, `/api/gates` and `/api/automations/summary` (topics `pace`, `mac`, `services`, `attesa`, `alerts`, `gates`, `automations`) from the hub while at least one window is connected, and broadcast a `hub:live` frame per topic only when its answer changed, or once when the topic stops being readable. A write the hub accepts through the bridge SHALL trigger a fresh read, so the change reaches every window without waiting for the next tick.

#### Scenario: Unchanged data costs no frame
- **GIVEN** a tick already pushed the three topics
- **WHEN** the next tick reads the same answers
- **THEN** no frame SHALL be sent

#### Scenario: A write is visible at once
- **GIVEN** a "waiting for you" item closed with `POST /api/hub/attesa` and the hub answered 2xx
- **WHEN** the bridge returns
- **THEN** the reader SHALL read again after any read already in flight, push the list without the item, and the bridge SHALL answer only after that read (bounded), so a `GET /api/hub-live` right after already holds the new list

#### Scenario: A window opening after the hub came back
- **GIVEN** the last read of a topic failed
- **WHEN** a window asks `GET /api/hub-live`
- **THEN** the server SHALL read the hub again before answering, instead of serving the error until the next tick

#### Scenario: Hub down drops the old numbers
- **GIVEN** the hub stops answering
- **WHEN** the next tick runs
- **THEN** one `hub:live` frame with `error` and no `data` SHALL be sent per topic, and `GET /api/hub-live` SHALL report the error instead of the last numbers

### Requirement: HUBBR-03 — Live hub data in the client

The client SHALL keep the latest `hub:live` reading per topic, seed it from `GET /api/hub-live` on the first subscription, on every socket re-open and after a write of its own, and never let an older reading replace a newer one.

#### Scenario: Seed after a frame
- **GIVEN** a frame at time 20 was adopted
- **WHEN** a seed reading at time 10 arrives
- **THEN** the store SHALL keep the reading at time 20

#### Scenario: A push missed while disconnected
- **GIVEN** the list changed while this window's socket was closed
- **WHEN** the socket opens again
- **THEN** the store SHALL read the snapshot again and hold the new list

### Requirement: HUBBR-04 — Status strip at the foot of the sidebar

The client SHALL show the system at a glance at the foot of the sidebar on the desktop (above the identity band, below the transport alarms) and above the bottom row on the phone: a dot and one sentence (calm, or something to look at), the number of services down, and a line of numbers (cpu, swap, the quota of the accounts in use). A click or tap SHALL open the System pane.

#### Scenario: No hub, no strip
- **GIVEN** no topic was ever read in this window
- **WHEN** the sidebar renders
- **THEN** the strip SHALL render nothing

#### Scenario: Hub down, no stale numbers
- **GIVEN** the hub was read once and every topic is now in error
- **WHEN** the strip renders
- **THEN** it SHALL say the hub is not reachable and show no number

### Requirement: HUBBR-05 — The System pane beside the work

The client SHALL open the System pane as one more column beside the work area, from the strip and from the command palette entry «Sistema»: the tab in front, the top-level tabs and the sidebar SHALL stay as they are. The pane SHALL show, in order: waiting for you (type, title, why, due, from, open link, close), agents (the same rows as the user menu's agents level) with one line of quotas, alerts, red gates, automations (counters, next run, failed jobs). "Open full view" SHALL widen the same pane over the work area and back. Below 768px the same content SHALL open in the bottom sheet.

#### Scenario: Beside, not instead
- **GIVEN** a chat open in the work area
- **WHEN** the strip is clicked
- **THEN** the System pane SHALL appear to the right of the chat, the chat SHALL stay visible, and the number of top-level tabs SHALL not change

#### Scenario: Closing a waiting item
- **GIVEN** an item in "waiting for you"
- **WHEN** its close action is pressed
- **THEN** the client SHALL `POST /api/hub/attesa` with `{"kind":"chiudi","ref":<id>}`, hide the row at once, read the snapshot again once the hub accepted, and bring the row back with the reason if the hub refuses

#### Scenario: Phone
- **GIVEN** a window narrower than 768px
- **WHEN** the strip above the bottom row is tapped
- **THEN** the pane content SHALL open in the bottom sheet over the chat
