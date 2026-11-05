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

The client SHALL keep the latest `hub:live` reading per topic, seed it from `GET /api/hub-live` on the first subscription, on every socket re-open and after a write of its own, and never let an older reading replace a newer one. Its readers of the hub's topics (waiting items, alerts, red gates, automations, services, quotas) SHALL drop what they do not recognise instead of throwing, and SHALL accept only http(s), `claude://` and the hub's own `#page` links, the last only where the window runs on the hub's machine.

#### Scenario: Seed after a frame
- **GIVEN** a frame at time 20 was adopted
- **WHEN** a seed reading at time 10 arrives
- **THEN** the store SHALL keep the reading at time 20

#### Scenario: A push missed while disconnected
- **GIVEN** the list changed while this window's socket was closed
- **WHEN** the socket opens again
- **THEN** the store SHALL read the snapshot again and hold the new list

### Requirement: HUBBR-04 — Without the hub, no trace

The client SHALL show nothing of the hub where the hub is absent or down: no status strip in the sidebar or above the phone's bottom row, no «Sistema» entry in the command palette, and no error in the console. The small System pane and the status strip are retired (HUBBR-05 is withdrawn): what they showed moves to the places listed in `openspec/changes/hub-smistamento/proposal.md`. A System pane (`__system__`) saved by an older version SHALL be dropped when the pane store loads, with every group reference to it.

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the app opens on the desktop and on a 390px phone
- **THEN** no strip SHALL render, the palette SHALL have no «Sistema» entry, and the console SHALL hold no error

#### Scenario: Hub down after it answered
- **GIVEN** the hub answered once and then stopped
- **WHEN** the app is reloaded
- **THEN** the sidebar SHALL be the same as without the hub, and the console SHALL hold no error

#### Scenario: A saved System pane
- **GIVEN** a pane snapshot holding `__system__` in a split cell beside a chat
- **WHEN** the pane store hydrates it
- **THEN** only the chat SHALL remain, and no group SHALL reference `__system__`

### Requirement: HUBBR-06 — The bell in groups, in one order

The bell («Da guardare» > Ora) SHALL list, in this order: «Decidi tu» (the waits of Topics and the hub's «waiting for you» items together), «Si è rotto» (failed automations, services with a problem or stopped), «Quote e account» (a window at 90% or more, the pace alerts, account switched, limit reached, token expired on the Claude proxy in the last 24 hours), «Da guardare» (projects over their budget, contradictions of the agents' rules), «Finite». A group with no row SHALL not render. In «Decidi tu» the items with a deadline SHALL come first, nearest first, then the longest wait; a hub group shows five rows and «Altre N». A service switched off on purpose or waiting on demand SHALL not enter. Where the hub is part of the installation the pill of the button SHALL say the figure of one group of the panel, never a sum the panel does not show: amber with the number of «Decidi tu» when something waits for the person, else the blue of the finished subjects, else grey with the hub's warnings; the Dock, the tray and the PWA badge keep ATTN-08. The rows SHALL write the time as the person reads it («adesso», «4 min», «21:26», «ieri»), and the foot of the panel SHALL say who is at work and whether the hub answers. Without the hub the bell SHALL be the Topics inbox, and the client SHALL ask nothing of `/api/hub/` or `/api/switchboard/`.

#### Scenario: Decide first
- **GIVEN** a hub with a «waiting for you» item due today, a failed automation, a stopped service, a full week, an account switch, a project over budget and a finished chat
- **WHEN** the bell opens
- **THEN** the groups SHALL be Decidi tu, Si è rotto, Quote e account, Da guardare, Finite, with the hub's item at the top of Decidi tu

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the bell opens
- **THEN** only the groups of Topics SHALL render and no request SHALL go to the hub's routes

### Requirement: HUBBR-07 — History with the filtered diary

The bell's History tab SHALL merge two days of the hub's diary into the Topics log by time, with a filter «Tutto», «Topics», «Automazioni e agenti». The diary SHALL bring failed runs, the agents' work («Risolvi tu» included), workflows and the person's own actions, and SHALL leave out the runs of automations that went well or were skipped: those stay on the automation's card.

#### Scenario: Routine runs stay out
- **GIVEN** a diary with a successful backup, a skipped brief and a failed reindex
- **WHEN** History opens
- **THEN** only the failed reindex SHALL be listed among the automation runs
