# remote-browser Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: BROWSER-01 — Navigation & Page Control

The system SHALL provide a remote browser panel with URL navigation, back/forward/reload controls, a URL address bar, and visual screenshot-based page rendering within a topic pane.

#### Scenario: Browser panel shows empty state when no session exists
- **GIVEN** a topic pane is configured to display the remote browser
- **WHEN** no browser context exists on the server for this pane
- **THEN** the panel SHALL display a "No browser session" placeholder with a Globe icon
- **AND** the URL bar SHALL be empty and ready for input

#### Scenario: User navigates to a URL via the address bar
- **GIVEN** the remote browser panel is visible with an empty or existing session
- **WHEN** the user types a URL into the address bar and submits
- **THEN** the system SHALL send a navigate request to POST /api/browsers/:id/interact with action "navigate"
- **AND** the panel SHALL display a loading indicator overlay

#### Scenario: Page screenshot renders after navigation completes
- **GIVEN** the user has navigated to a valid URL
- **WHEN** the server returns a successful navigate response
- **THEN** the panel SHALL fetch a screenshot from GET /api/browsers/:id/snapshot
- **AND** the screenshot SHALL render as an image filling the panel area with object-contain scaling

#### Scenario: URL bar updates to reflect the current page URL
- **GIVEN** the browser has navigated to a page
- **WHEN** the server returns page info including the current URL
- **THEN** the URL bar SHALL update to display the current page URL
- **AND** the parent component SHALL be notified of the URL change via onUrlChange callback

#### Scenario: User navigates back in browser history
- **GIVEN** the browser has visited at least two pages
- **WHEN** the user clicks the Back button in the toolbar
- **THEN** the system SHALL send an interact request with action "back"
- **AND** the screenshot and URL SHALL update to reflect the previous page

#### Scenario: User navigates forward in browser history
- **GIVEN** the browser has navigated back from a page
- **WHEN** the user clicks the Forward button in the toolbar
- **THEN** the system SHALL send an interact request with action "forward"
- **AND** the screenshot and URL SHALL update to reflect the next page in history

#### Scenario: User reloads the current page
- **GIVEN** the browser is displaying a page
- **WHEN** the user clicks the Reload button in the toolbar
- **THEN** the system SHALL send an interact request with action "reload"
- **AND** a loading indicator SHALL appear until the new screenshot is fetched

#### Scenario: User clicks the Home button
- **GIVEN** the browser is displaying a page
- **WHEN** the user clicks the Home button in the toolbar
- **THEN** the browser SHALL navigate to about:blank
- **AND** the panel SHALL return to the "Browser ready" state

#### Scenario: External navigation via navigateUrl prop
- **GIVEN** the remote browser panel is mounted with a navigateUrl prop
- **WHEN** the navigateUrl prop changes to a new URL
- **THEN** the browser SHALL automatically navigate to that URL
- **AND** the onNavigateConsumed callback SHALL be invoked to clear the prop

#### Scenario: Loading overlay appears during page navigation
- **GIVEN** the browser has a current screenshot displayed
- **WHEN** a new navigation is in progress
- **THEN** a semi-transparent loading overlay with a spinner SHALL appear over the screenshot
- **AND** the overlay SHALL disappear once the new screenshot loads

#### Scenario: Browser ready state displays after connection with blank page
- **GIVEN** the browser context exists on the server
- **WHEN** the current URL is about:blank or empty
- **THEN** the panel SHALL display a "Browser ready" message with a Globe icon
- **AND** a hint "Enter a URL above to navigate" SHALL be visible

#### Scenario: Starting browser state displays during initial connection
- **GIVEN** the browser context is being created on the server
- **WHEN** the connection is being established but no screenshot is available yet
- **THEN** the panel SHALL display a spinning loader with "Starting browser..." text

#### Scenario: Browser context info is polled periodically
- **GIVEN** the remote browser panel is mounted
- **WHEN** the panel is idle with no user interaction
- **THEN** the system SHALL poll GET /api/browsers/:id for context info every 2 seconds
- **AND** when the user interacts, polling SHALL accelerate to every 300ms for 3 seconds

#### Scenario: Screenshot is fetched only when context exists
- **GIVEN** the polling loop checks for browser context
- **WHEN** the server returns 404 for the context info request
- **THEN** the system SHALL NOT attempt to fetch a screenshot
- **AND** the panel SHALL show the disconnected state

#### Scenario: Server lists all active browser contexts
- **GIVEN** one or more browser contexts exist on the server
- **WHEN** a client sends GET /api/browsers
- **THEN** the server SHALL return a JSON array of all active browser context details

### Requirement: BROWSER-02 — Agent Interaction

The system SHALL support agent-driven browser interactions including click, type, scroll, hover, screenshot capture, accessibility tree retrieval, JavaScript evaluation, and cookie management through a unified REST endpoint.

#### Scenario: Agent clicks at specific coordinates
- **GIVEN** a browser context with a loaded page
- **WHEN** a POST request is sent to /api/browsers/:id/interact with action "click" and x/y coordinates
- **THEN** the server SHALL perform a click at the specified coordinates on the page
- **AND** the response SHALL return { ok: true }

#### Scenario: Agent types text into focused element
- **GIVEN** a browser context with a focused input element
- **WHEN** a POST request is sent with action "type" and a text value
- **THEN** the server SHALL type the specified text into the focused element
- **AND** the response SHALL return { ok: true }

#### Scenario: Agent presses a special key
- **GIVEN** a browser context with a loaded page
- **WHEN** a POST request is sent with action "keypress" and a key name
- **THEN** the server SHALL press the specified key (e.g., Enter, Tab, Escape)
- **AND** the response SHALL return { ok: true }

#### Scenario: Agent scrolls at specific coordinates
- **GIVEN** a browser context with a scrollable page
- **WHEN** a POST request is sent with action "scroll" and deltaX/deltaY values
- **THEN** the server SHALL scroll the page by the specified delta at the given coordinates

#### Scenario: Agent hovers over specific coordinates
- **GIVEN** a browser context with a loaded page
- **WHEN** a POST request is sent with action "hover" and x/y coordinates
- **THEN** the server SHALL move the cursor to the specified position without clicking

#### Scenario: Agent takes a screenshot
- **GIVEN** a browser context with a loaded page
- **WHEN** a POST request is sent with action "screenshot"
- **THEN** the server SHALL capture and return the current page screenshot as an image
- **AND** the format (png/jpeg), quality, and fullPage options SHALL be respected

#### Scenario: Agent retrieves accessibility snapshot
- **GIVEN** a browser context with a loaded page
- **WHEN** a POST request is sent with action "snapshot"
- **THEN** the server SHALL return the accessibility tree of the current page as JSON
- **AND** the response SHALL include the page URL, title, and ARIA snapshot

#### Scenario: Agent retrieves text-based accessibility snapshot
- **GIVEN** a browser context with a loaded page
- **WHEN** a GET request is sent to /api/browsers/:id/a11y
- **THEN** the server SHALL return a plain text representation with URL, title, and ARIA snapshot

#### Scenario: Agent evaluates JavaScript on the page
- **GIVEN** a browser context with a loaded page
- **WHEN** a POST request is sent with action "evaluate" and a script string
- **THEN** the server SHALL execute the JavaScript in the page context
- **AND** the response SHALL include the evaluation result

#### Scenario: Agent clicks an element by CSS selector
- **GIVEN** a browser context with a loaded page
- **WHEN** a POST request is sent with action "click_selector" and a CSS selector
- **THEN** the server SHALL locate and click the element matching the selector

#### Scenario: Agent fills an input by CSS selector
- **GIVEN** a browser context with a loaded page
- **WHEN** a POST request is sent with action "fill" and a selector plus value
- **THEN** the server SHALL fill the matched input element with the specified value

#### Scenario: Agent saves cookies for a browser context
- **GIVEN** a browser context with active cookies
- **WHEN** a POST request is sent with action "save_cookies"
- **THEN** the server SHALL persist the current cookies for later restoration

#### Scenario: Agent loads previously saved cookies
- **GIVEN** cookies have been saved for a browser context
- **WHEN** a POST request is sent with action "load_cookies"
- **THEN** the server SHALL restore the previously saved cookies into the browser context

#### Scenario: Agent resizes the browser viewport
- **GIVEN** a browser context exists
- **WHEN** a POST request is sent with action "resize" and width/height values
- **THEN** the server SHALL resize the browser viewport to the specified dimensions

#### Scenario: Agent retrieves console messages
- **GIVEN** a browser context has logged messages to the console
- **WHEN** a GET request is sent to /api/browsers/:id/console
- **THEN** the server SHALL return all captured console messages for that context

#### Scenario: User clicks on screenshot to interact with page
- **GIVEN** the browser panel is displaying a page screenshot
- **WHEN** the user clicks on the screenshot image
- **THEN** the click coordinates SHALL be mapped from the display image to the actual viewport dimensions
- **AND** an interact request with action "click" SHALL be sent with the mapped x/y coordinates

#### Scenario: User scrolls on screenshot to scroll the page
- **GIVEN** the browser panel is displaying a page screenshot
- **WHEN** the user scrolls the mouse wheel over the screenshot
- **THEN** scroll events SHALL be throttled to one per 100ms
- **AND** the deltaX/deltaY values SHALL be sent via an interact request with action "scroll"

#### Scenario: User types text via keyboard into the browser
- **GIVEN** the browser panel container is focused
- **WHEN** the user types regular characters on the keyboard
- **THEN** the characters SHALL be buffered for 50ms and sent as a single "type" action
- **AND** special keys (Enter, Tab, Escape, arrows, function keys) SHALL be sent immediately as "keypress" actions

#### Scenario: Browser context is deleted when pane closes
- **GIVEN** a browser pane is open with an active server-side context
- **WHEN** the user closes the browser pane
- **THEN** a DELETE request SHALL be sent to /api/browsers/:id
- **AND** the server SHALL destroy the browser context and broadcast a "browser-deleted" event


### Requirement: BROWSER-CHAT-01 — Per-topic browser state persists to disk and is restored on cold open

The system SHALL persist a browser context's storage state to
`<DATA_DIR>/browser-state/<sanitized-contextId>/storage.json`, flushing it synchronously
when the context is destroyed, and SHALL restore both that storage state and the last
visited URL when the context is created again from cold. The topic's `browserState.url`
SHALL reflect the last navigation.

#### Scenario: Storage file is written when the context closes
- **GIVEN** a topic whose browser context has been opened and navigated to a URL via `POST /api/browsers/:id/agent/open`
- **WHEN** the context is destroyed via `DELETE /api/browsers/:id`
- **THEN** `storage.json` exists at the canonical path for that context id
- **AND** it parses to an object with a `cookies` array and an `origins` array

#### Scenario: Reopening from cold restores the URL
- **GIVEN** the context was destroyed after navigating to `https://example.com`
- **WHEN** a request re-creates it lazily (`POST /api/browsers/:id/agent/screenshot`)
- **THEN** the call succeeds and returns a file `path` plus a positive `bytes`, and no inline base64 payload
- **AND** the bytes on disk at that path match the reported size
- **AND** `GET /api/browsers/:id` reports a URL containing `example.com` — the fresh context is not sitting on `about:blank`
- **AND** the topic's `browserState.url` contains `example.com`

### Requirement: BROWSER-CHAT-02 — Live pane transport: push frames, input latency, degradation and recovery

The system SHALL stream the remote browser pane over a per-context WebSocket
(`/ws/browser/:id`), driving the pane's rendered surface, and SHALL degrade and recover
without stranding the pane. Numeric ceilings are read from
`tests/e2e/perf-baseline.json` (`browser_ws_streaming`), not hard-coded here.

#### Scenario: First frame arrives push-driven after the socket opens
- **GIVEN** a browser pane is mounted for a topic via the `browser:open-and-navigate` event
- **WHEN** the first `frame` message arrives on the browser WebSocket
- **THEN** the elapsed time since the socket opened is below the `first_frame_ms_ceiling` baseline

#### Scenario: Input round-trip stays under the p95 ceiling
- **GIVEN** a connected pane whose clickable surface is the WebRTC `<video>` element
- **WHEN** the user clicks it repeatedly until at least `input_latency_sample_size_min` click→frame pairs are measured
- **THEN** the p95 of those round trips is below the `input_latency_p95_ms_ceiling` baseline

#### Scenario: Sustained frame rate stays within the bandwidth ceiling
- **GIVEN** a connected pane receiving frames
- **WHEN** at least `frame_count_in_2s_floor` frames have arrived
- **THEN** the measured bandwidth is below the `bandwidth_kbps_ceiling` baseline

#### Scenario: A transient socket drop reconnects and the surface returns
- **GIVEN** a connected pane showing the WebRTC `<video>` surface
- **WHEN** the WebSocket is closed underneath it
- **THEN** the client opens a NEW socket rather than staying in polling
- **AND** the `<video>` surface returns once the transport renegotiates

#### Scenario: With no socket at all the pane reports fallback, never "connecting"
- **GIVEN** the browser WebSocket constructor throws so no socket can be opened
- **WHEN** the pane mounts
- **THEN** the connection indicator is visible and carries the `connection-fallback` class within the `fallback_http_grace_ms_ceiling` baseline
- **AND** it does not carry the `connection-connecting` class

#### Scenario: The pane streams its real size on open and on resize
- **GIVEN** a browser pane has just opened its socket
- **THEN** a `resize` message is sent carrying a positive width, a positive height and a `deviceScaleFactor` of at least 1
- **WHEN** the window is resized
- **THEN** a further `resize` message is sent

#### Scenario: A download announces itself in the toolbar and is dismissible
- **GIVEN** a connected pane
- **WHEN** the server pushes a completed download
- **THEN** a downloads button appears in the toolbar and its menu opens by itself, with no separate strip at the foot of the pane
- **AND** the menu entry names the file, links to its href and shows its size
- **WHEN** the user presses Escape the menu closes, and clicking the button reopens it
- **WHEN** the user dismisses the last entry, the downloads button disappears

### Requirement: BROWSER-CHAT-03 — Agent control of the browser over REST, including other sessions' tabs

The system SHALL expose the browser to an agent through per-context REST endpoints
(`open`, `observe`, `get-text`, `extract`, `act`, `point`), SHALL broadcast an
`agent_active` true→false pair around every locked operation even when the operation
fails, and SHALL let a session that owns no pane list and drive another topic's tab by
`contextId`.

#### Scenario: browser_open navigates and reports the landed page
- **WHEN** the agent posts a URL to `POST /api/browsers/:id/agent/open`
- **THEN** the response carries no `error`, a `url` matching the requested host and a string `title`

#### Scenario: browser_observe returns a compact ref snapshot, with the screenshot opt-in
- **GIVEN** a context sitting on a page
- **WHEN** the agent posts `{ full: true }` to `agent/observe`
- **THEN** the response carries a `snapshot` of numbered ref lines (`[1] link …`), a `count` of at least 1, `full: true` and a non-empty `url`
- **AND** `screenshot_annotated` is absent — the heavy payload is opt-in
- **WHEN** the agent observes again without `full`
- **THEN** the response reports `full: false` and an incremental snapshot ("no element changes" / "same structure" / "navigated")
- **WHEN** the agent observes with `{ screenshot: true }`
- **THEN** `screenshot_annotated` is a base64 JPEG or PNG of non-trivial size

#### Scenario: get-text and extract read the page
- **GIVEN** a context sitting on a page
- **WHEN** the agent posts to `agent/get-text`
- **THEN** it receives non-empty `text`
- **WHEN** the agent posts `{ fields: { heading: "h1" } }` to `agent/extract`
- **THEN** it receives no `error` and a string value for `heading`

#### Scenario: agent_active pairs even when the action fails
- **GIVEN** a client listening on `/ws/browser/:id`
- **WHEN** the agent posts an `act` naming an element id that does not exist
- **THEN** the endpoint fails soft (HTTP 200 with an `error`, or 500)
- **AND** the socket has received an `agent_active: true` followed by an `agent_active: false`

#### Scenario: A pane-less session lists and drives another topic's tab
- **GIVEN** topic A has an open browser context, and a session key that owns no pane of its own
- **WHEN** that session posts to `/api/sessions/:key/browser/list-tabs`
- **THEN** topic A's tab is listed with `kind: "topic"`, the topic's name as `label`, its current URL, and `isOwn: false`
- **WHEN** that session posts `get-text` with `contextId` set to topic A
- **THEN** it receives non-empty text
- **WHEN** it posts `get-text` with an unknown `contextId`
- **THEN** the response is HTTP 404 with an error naming "unknown contextId" and listing the live ids, and no phantom context is created

#### Scenario: browser_point fails soft when the vision backend is unavailable
- **GIVEN** the Moondream backend is unreachable or unauthenticated on the test server
- **WHEN** the agent posts a description to `agent/point`
- **THEN** the response is either a structured `error` naming the cause, or a success carrying `clicked: true` and numeric point coordinates

#### Scenario: The OpenClaw browser-isolation bridge is gone
- **WHEN** `server/routes/topics.ts` is read
- **THEN** it contains no occurrence of `browserTargetIdCache`, `BROWSER ISOLATION`, `isolationInstruction` or `BrowserIsolation`

### Requirement: BROWSER-CHAT-04 — Opening, driving and closing a browser pane from a topic

The system SHALL mount a remote browser pane inside a topic from the chat surface, SHALL
show the agent-controlling overlay while an agent holds the lock, SHALL let the user take
control back, SHALL offer a select-element mode that feeds the chat, and SHALL close the
pane in live clients on a remote close.

#### Scenario: A browser pane can be opened in a topic
- **GIVEN** a topic is open
- **WHEN** the user picks Browser from the add-pane menu, or the canonical `browser:open-and-navigate` event is dispatched
- **THEN** a pane root marked `[data-browser-pane]` is visible

> Written from the test, and no wider: the E2E falls back to dispatching the event when
> the add-pane menu does not expose a Browser entry, so what is pinned is that the pane
> mounts, not that the menu path is the one taken.

#### Scenario: /browser <url> opens the pane and labels the tab
- **GIVEN** a topic chat is open and focused
- **WHEN** the user sends `/browser https://example.com` in the composer
- **THEN** a `[data-browser-pane]` root becomes visible
- **AND** a tab is shown naming the destination (or the generic browser/chat label while the shared session is still negotiating)

#### Scenario: @browser registers the browser tool surface with the provider
- **GIVEN** the server is running a passthrough provider (`claude` or `openai`)
- **WHEN** the user sends a message beginning with `@browser`
- **THEN** the provider request carries at least the tools `browser_open`, `browser_observe`, `browser_act`, `browser_extract`, `browser_screenshot` and `browser_point`
- **AND** on any other provider the scenario does not apply — the tool surface is upstream-managed

#### Scenario: The agent-controlling overlay follows the agent_active broadcast
- **GIVEN** a mounted browser pane connected to its socket
- **THEN** the agent-controlling overlay is hidden
- **WHEN** `agent_active: true` is broadcast, the overlay becomes visible
- **WHEN** `agent_active: false` is broadcast, the overlay hides again

#### Scenario: Take control sends take_control and releases the overlay
- **GIVEN** the agent-controlling overlay is showing
- **WHEN** the user clicks the Take control button
- **THEN** a `take_control` message is sent on the browser socket
- **AND** the overlay hides once the server re-broadcasts `agent_active: false` — the client does not clear it optimistically

#### Scenario: Cmd+Shift+E selects an element and feeds it to the chat
- **GIVEN** a mounted browser pane showing the WebRTC `<video>` surface
- **WHEN** the user presses Cmd+Shift+E
- **THEN** the select-element overlay mounts
- **WHEN** the user clicks a point on the overlay
- **THEN** a `chat:insert-text` event carries the element's identification (css path and selector), its bounding box, its markup in an HTML code block and its computed style in a CSS code block
- **AND** a separate `chat:attach-image` event carries the crop as a `data:image/png;base64,` attachment

#### Scenario: localhost is not force-framed — it follows the framable probe
- **GIVEN** a pane pointed at `http://localhost:3333` whose `/api/browsers/framable` probe reports `framable: false`
- **WHEN** the pane renders
- **THEN** no iframe is rendered — the retired localhost force-frame does not return
- **AND** the pane falls back to the streaming WebRTC surface rather than a dead pane

#### Scenario: A remote close removes the pane in live clients
- **GIVEN** a mounted browser pane whose context id is the topic id
- **WHEN** `POST /api/topics/:id/browser/close-pane` is called
- **THEN** the request succeeds and the pane root disappears from the live client

### Requirement: CD-CLOSE-01 — A browser tab closed on one device disappears live on the other

> Written from `tests/e2e/browser-cross-device-close.spec.ts`. It lives here
> rather than under `tab-sync-e2e` because it is specific to BROWSER panes: the
> generic cross-device pane reconciliation (`TAB-SYNC-02`) merges as a UNION, so
> a removal there deliberately does NOT propagate, and browser closes ride a
> separate rail. The two eviction guards — a pane re-opened after the close, and
> the five-minute window — are not exercised by this test.

Closing a browser tab on one device SHALL remove it from another connected
device LIVE, without a reload. The pane-store's cross-device broadcast
reconciles with a union so that no client can wipe another's tabs, which means a
removal does not travel that way; the close therefore SHALL travel as its own
close-marker, synced over `/ws`, and the receiving device SHALL evict the
matching `browser:<context>` pane on receipt rather than merely stop resurrecting
it at the next hydrate.

The eviction SHALL be targeted: a sibling browser tab SHALL survive.

#### Scenario: Both devices show both browser tabs
- **GIVEN** two connected clients and two browser panes seeded in the shared pane store before either loads
- **WHEN** the second device finishes hydrating
- **THEN** it SHALL show a tab for each of the two browser panes

#### Scenario: The close propagates without a reload
- **GIVEN** those two devices
- **WHEN** the first device closes one browser tab through the tab's own close control
- **THEN** the second device SHALL stop showing that tab, without being reloaded

#### Scenario: The sibling tab survives
- **GIVEN** the same close
- **WHEN** the second device is inspected afterwards
- **THEN** the other browser tab SHALL still be visible

### Requirement: CD-CLOSE-02 — Closing a browser tab publishes its close-marker to the shared channel

The GLOBAL close path SHALL write the cross-device close-marker, not only the
close path of a tab inside a project. Writing it in one of the two places is
exactly the gap that left a tab closed on the desktop still standing on the
phone.

The marker SHALL be published to the shared `tombstones-browser` key of the
`ui_state` channel, listing the context id of the closed browser tab.

#### Scenario: A global browser tab's close is published
- **GIVEN** a connected client showing a global (non-project) browser tab
- **WHEN** the tab is closed through its own close control
- **THEN** the shared `tombstones-browser` value SHALL come to list that tab's context id
