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

#### Scenario: Hub down after it answered
- **GIVEN** the bell open with the hub's groups listed
- **WHEN** the hub stops answering
- **THEN** the hub's groups SHALL go, the band with «Riprova» SHALL show, and «Riprova» with the hub back SHALL bring the groups back

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

The bell («Da guardare» > Ora) SHALL list, in this order: «Decidi tu» (the waits of Topics and the hub's «waiting for you» items together), «Si è rotto» (failed automations, services with a problem or stopped), «Quote e account» (a window at 90% or more, the pace alerts, account switched, limit reached, token expired on the Claude proxy in the last 24 hours), «Da guardare» (projects over their budget, contradictions of the agents' rules), «Finite». A group with no row SHALL not render. In «Decidi tu» the items with a deadline SHALL come first, nearest first, then the longest wait, every one of them in view; a group of the hub's warnings («Si è rotto», «Quote e account», «Da guardare») shows five rows and «Altre N». A service switched off on purpose or waiting on demand SHALL not enter. Where the hub is part of the installation the pill of the button SHALL say the figure of one group of the panel, never a sum the panel does not show: amber with the number of «Decidi tu» when something waits for the person, else the blue of the finished subjects, else grey with the hub's warnings; the Dock, the tray and the PWA badge keep ATTN-08. The rows SHALL write the time as the person reads it («adesso», «4 min», «21:26», «ieri»), and the foot of the panel SHALL say who is at work and whether the hub answers. Without the hub the bell SHALL be the Topics inbox, and the client SHALL ask nothing of `/api/hub/` or `/api/switchboard/`. With the hub read once in the window and silent now, the panel SHALL list Topics alone under a band «Hub non raggiungibile: vedi solo Topics» with «Riprova», and the foot SHALL say since when («hub fermo da 4 min»). With nothing in any group the panel SHALL say «Niente aspetta te, niente di rotto.» (only «Niente aspetta te.» when the hub does not answer) with a link to the History tab. The rows SHALL carry the mockup's actions where an answer exists: a chat's permission «Consenti» and «Nega» (the same decision as its panel in the chat), a hub item «Apri» and «Fatto», a failed automation «Risolvi tu», an expired token of the Claude proxy «Rinnova».

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

### Requirement: HUBBR-08 — The machine's Processes

Where the hub is part of the installation, Sistema in the Topics menu and the command palette SHALL open «Processi», a view of the whole machine that takes the place of «Questo computer» (what that level said about this window, open tabs, archived and the health list, moves under Prestazioni). The view SHALL show the Mac (CPU, memory, swap, GPU and network of the machine, then the processes by memory with memory, GPU and network for each, and the CPU of the processes the hub measures), the PC (asleep, on or working, with the hub's reasons, its measures and its heavy programs), the hub's services (state, memory, port; the stopped ones first, the ones switched off on purpose counted, not listed) and the Claude proxy's log. A number the hub did not measure SHALL be a dash, never 0. The only command SHALL be «Ferma» on a running project script started by Topics, with the project's name and the script's port; no row of an app, a service, a session or the system SHALL carry a stop or a restart. Without the hub the row and the palette entry SHALL not exist.

#### Scenario: GPU and network per process
- **GIVEN** a hub whose census measures GPU and network for some processes and not for one
- **WHEN** «Processi» opens
- **THEN** each measured row SHALL show its GPU and its network, the other SHALL show a dash, and only the row of the running project script SHALL carry «Ferma»

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** Sistema and the palette open
- **THEN** neither SHALL offer «Processi»

### Requirement: HUBBR-09 — The proxy's log, live, closed with the view

The log section of «Processi» SHALL read the Claude proxy's log stream through the Topics proxy while the view is open and the log is open, newest line first, with «Tutto», «Solo errori» and a pause. Closing the log from the proxy's row, or closing the view, SHALL close the stream.

#### Scenario: Closed with the view
- **GIVEN** «Processi» open with the log reading the stream
- **WHEN** the view's tab is closed
- **THEN** the proxy SHALL see the stream end


### Requirement: HUBBR-10 — Accounts and quotas, with commands only on the proxy's accounts

Where the hub is part of the installation, the menu with your name SHALL carry, under the plan, a row «Account e quote» whose tail says the hottest quota of a plan in use from 80% (amber) and how many accounts the view lists (the proxy's Claude accounts plus Codex and Muse), the same number as the view's header; the card with your name SHALL show the same hottest quota from 80% and nothing below it. The row and the palette SHALL open «Account e quote», a view that SHALL show: at the top, under «Decidi tu», the Claude account in use when a window is at 80% or more, with the board's 90% line, the reset, «Passa a» the next ready account and the stop of the background work; the command that stops the new background work for some hours (and resumes it); the Claude accounts of the proxy, the one in use first, then by priority, the switched-off ones last, each with its five hours and week bars, its cap marker and its state (in uso, pronto, spento, tetto raggiunto, esaurito, token scaduto), with the proxy's commands: «Usa questo», priority up and down, the account's own caps, «Aggiorna token», on and off, «Togli l'account» after a confirmation; Codex and Muse with their bars read-only, no account command, and «Sblocca il freno per 2 ore» (or «Rimetti il freno» while unlocked); the reserve Anthropic API keys in the order the proxy uses them, with priority up and down and on and off; «Come funziona il freno», per class of work the providers in order and the current pick, and each provider's quota used against the week gone; the hub's own Italian reasons SHALL be shown only in Italian, with comma decimals. With the hub silent the bars SHALL keep their last reading under a band that says since when. Without the hub the row, the palette entry and the card's quota SHALL not exist.

#### Scenario: Commands only on Claude
- **GIVEN** a hub with Claude accounts on the proxy, Codex and Muse metered
- **WHEN** «Account e quote» opens
- **THEN** each Claude card SHALL carry the proxy's commands, the Codex and Muse cards SHALL carry only «Sblocca il freno per 2 ore», and «Usa questo» SHALL reach the proxy as a switch to that account

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the menu with your name and the palette open
- **THEN** neither SHALL offer «Account e quote», and the card SHALL show no quota

### Requirement: HUBBR-11 — Rotation and caps write the proxy's settings and read them back

The section «Rotazione e tetti» of «Account e quote» SHALL show the Claude proxy's settings (proxy on, automatic switch, rotation strategy with its interval or parallel requests where the strategy has one, the five hours and week caps of every account, the wait when all are stopped, requests in line, dollar to euro) and every change SHALL be written to the proxy and then read back from it: the value on screen is the one the proxy answers. The Notifications level of the user menu SHALL carry «Avvisi del proxy degli account», the proxy's own notifications setting, written and read back the same way, only where the hub is and the proxy answers.

#### Scenario: A cap written and read back
- **GIVEN** «Account e quote» open with the proxy's week cap off
- **WHEN** the week cap of every account is set to 90%
- **THEN** the proxy SHALL receive the cap, and the row SHALL show 90% as read again from the proxy

### Requirement: HUBBR-12 — Consumi in the Dashboard: hub sections only with the hub, amounts in euro, savings only for Claude

The menu with your name SHALL carry a row «Consumi» that opens the Dashboard; where the hub is part of the installation its tail SHALL say today's Claude tokens and their list price in euro. «Consumo per progetto» SHALL leave the System level and live in the Dashboard. Where the hub is, the Dashboard SHALL be «Consumi» and show, for the window chosen among Oggi, Settimana and 30 g: at the top, under «Decidi tu», a project past the week cap you set, with «Alza a N%» written to the hub and read back; the Claude tokens of the window, their cost at the API list price, what the plans cost for the window, the saving against the list price and the jobs given to Muse; the tokens per model over time; per model, per account (Claude from the proxy with five hours and week, Codex and Muse read-only from the hub) and per project (Claude, Codex and Muse as a share of the week, with your cap as a marker); the saving against the list price, for Claude only, and what Muse took off Claude; the board's work in one compact box. Every amount SHALL be in euro with the proxy's dollar to euro rate. The proxy's rows SHALL be summed by the Topics server (`GET /api/hub-usage`), never sent whole to a window, and a window the proxy's history does not cover SHALL say from when the data starts. Without the hub the Dashboard SHALL be the board's numbers as before, with «Consumo per progetto», and no hub section, no error.

#### Scenario: Consumi with the hub
- **GIVEN** a hub with a project past its cap and the proxy's rows of the week
- **WHEN** «Consumi» opens from the menu with your name
- **THEN** the Dashboard SHALL show «Decidi tu» with that project, the five numbers in euro, per model, per account and per project, and the saving for Claude only; «Alza a N%» SHALL reach the hub as the project's new cap

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** «Consumi» opens
- **THEN** the Dashboard SHALL show the board's numbers and «Consumo per progetto», and no hub section
