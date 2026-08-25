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

### Requirement: BROWSER-KBD-01 — La tastiera la sceglie il campo che hai toccato, non quello che riceve il fuoco

Toccando un campo dentro un pane browser dal telefono, la tastiera che si apre
SHALL corrispondere al TIPO di quel campo. Nel co-browse la pagina remota è uno
specchio non interattivo: il fuoco lo prende un campo di cattura NOSTRO, e il
sistema operativo sceglie la tastiera guardando quello — quindi email, numero e
password davano tutti la tastiera di testo.

Il profilo di tastiera SHALL essere copiato sul campo di cattura PRIMA di dargli
il fuoco: gli attributi vengono letti al momento del fuoco, e cambiarli dopo non
aggiorna una tastiera già aperta.

Dal nodo effettivamente toccato il sistema SHALL RISALIRE al campo che scrive
davvero — il dito atterra sull'etichetta, sulla cornice, sull'icona dentro il
bordo — seguendo le tre forme in cui i siti veri scrivono un campo: il campo che
contiene il punto, l'etichetta che punta al proprio controllo, l'etichetta che lo
avvolge. La risalita SHALL essere LIMITATA in profondità.

Un elemento che NON è un campo SHALL produrre nessun profilo, non quello di
ripiego: aprire una tastiera su un bottone è un difetto, non un default.

La DECISIONE su quali attributi producono quale tastiera SHALL stare in un punto
solo, condiviso col server: sul ramo video non esiste nessuno specchio da
interrogare e il descrittore del campo a fuoco arriva dalla rete. Una tabella
sola, due strade per riempirla.

#### Scenario: il dito sull'etichetta
- **GIVEN** un tocco sull'etichetta di un campo email
- **THEN** SHALL essere risolto il campo email, e la tastiera SHALL essere quella delle email

#### Scenario: il dito su un bottone
- **GIVEN** un tocco su un elemento che non scrive
- **THEN** NON SHALL essere applicato nessun profilo di tastiera

### Requirement: BROWSER-FORGET-01 — Si cancella ESATTAMENTE ciò che è stato mostrato

Fra il «cosa cancello» che una persona ha LETTO e il «cancella» che ha premuto NON
SHALL infilarsi un secondo confronto: la cancellazione SHALL passare al servizio
ESATTAMENTE i nomi elencati, senza ricavarli di nuovo dall'indirizzo.

L'elenco SHALL essere PRECISO: un sottodominio è un contenitore SUO e NON SHALL
finire dentro quello del dominio padre.

Un motore che NON è il nostro SHALL essere DICHIARATO tale, invece di elencare
zero contenitori — che si legge come «non c'è niente da cancellare».

Senza l'elenco la richiesta SHALL essere RIFIUTATA, e il servizio NON SHALL essere
chiamato. Le voci che non sono nomi SHALL essere SCARTATE invece di essere passate
giù. Un elenco VUOTO SHALL essere una richiesta valida che non cancella niente.

#### Scenario: un sottodominio
- **GIVEN** un contenitore di un sottodominio
- **THEN** NON SHALL essere cancellato insieme al dominio padre

#### Scenario: nessun elenco
- **GIVEN** una richiesta senza i nomi da cancellare
- **THEN** SHALL essere rifiutata senza chiamare il servizio

### Requirement: BROWSER-CHROME-01 — I toni dei segnali usano i valori MISURATI, e ogni tono nomina entrambi i temi

I toni di stato SHALL usare i valori di colore MISURATI sopra la propria tinta di
fondo, non una sfumatura grezza: misurate nel tema chiaro, due delle sfumature
usate stavano sotto la soglia di leggibilità, e solo una la superava.

NESSUN tono SHALL reintrodurre una sfumatura che quella misura ha bocciato, e il
tono attivo NON SHALL ricadere sul colore del marchio non misurato nel tema
chiaro.

OGNI valore di colore SHALL nominare una sfumatura per ENTRAMBI i temi, e nessuno
SHALL inchiodare bianco o nero. Ogni tono SHALL portare un fondo E un colore di
testo.

#### Scenario: il tema chiaro
- **GIVEN** un tono sopra la propria tinta
- **THEN** SHALL superare la soglia di leggibilità

#### Scenario: un tono nuovo
- **GIVEN** un valore che nomina una sola sfumatura
- **THEN** il banco SHALL fallire

### Requirement: BROWSER-DEV-01 — La modalità dispositivo si legge dall'IDENTIFICATIVO che la vista sta servendo

La modalità di emulazione SHALL essere DEDOTTA dall'identificativo che la vista
sta REALMENTE servendo, non da uno stato tenuto a parte: ogni volta che quello si
desincronizzava il selettore tornava a dire una cosa mentre il sito ne vedeva
un'altra.

Le due modalità che emulano SHALL portare un identificativo; quelle che NON
emulano NON SHALL portarne, né una misura.

Le due modalità che emulano NON SHALL essere confuse fra loro pur condividendo
parte del testo.

NON SHALL essere dichiarata una modalità che la pagina non può riportare.

Nessuna preimpostazione SHALL portare campi che nessuno legge.

#### Scenario: un identificativo di telefono
- **GIVEN** la vista che serve quell'identificativo
- **THEN** la modalità SHALL essere quella del telefono

#### Scenario: un identificativo qualunque
- **GIVEN** un identificativo non riconosciuto
- **THEN** SHALL valere la modalità che non emula

### Requirement: BROWSER-CONSOLE-01 — La console raggruppa le ripetizioni, e il filtro decide cosa si copia

Voci CONSECUTIVE identiche SHALL diventare UNA riga con il proprio moltiplicatore:
una scrittura dentro un ciclo di disegno riempiva la console di centinaia di copie
finché l'errore che si stava cercando usciva dal registro.

Lo stesso testo con LIVELLO diverso NON SHALL fondersi. Due identiche separate da
una TERZA SHALL restare due; separate solo da una riga FILTRATA VIA SHALL fondersi
— il raggruppamento avviene DOPO il filtro. Il gruppo SHALL portare istante,
identificativo e sorgente della PRIMA occorrenza.

I contatori per livello SHALL contare ciò che la RICERCA ha lasciato passare, e
NON SHALL restringersi quando si sceglie un livello.

La ricerca SHALL ignorare maiuscole e minuscole, SHALL guardare anche la
SORGENTE, e gli spazi agli ESTREMI NON SHALL far sparire tutto.

L'istante SHALL avere una larghezza FISSA anche quando manca: un segnaposto della
stessa misura, non una riga che si accorcia.

Il modulo NON SHALL modificare le voci che riceve.

La copia SHALL portare SOLO ciò che si vede, e niente da copiare SHALL essere una
stringa vuota, non una riga bianca.

#### Scenario: cinquecento copie della stessa riga
- **GIVEN** voci consecutive identiche
- **THEN** SHALL diventare una riga con il moltiplicatore

#### Scenario: la copia con un filtro attivo
- **GIVEN** un filtro che nasconde parte delle righe
- **THEN** SHALL essere copiato solo ciò che si vede

### Requirement: BROWSER-FIND-01 — Il contatore «n su m» non esce mai di scala, e cicla in entrambi i versi

La ricerca nella pagina non dice quante corrispondenze ci sono né su quale si è:
l'indice lo teniamo NOI, e SHALL poter sbagliare solo in modi visibili.

Da fermo il primo passo AVANTI SHALL essere la PRIMA corrispondenza, il primo
passo INDIETRO l'ULTIMA. Dopo l'ultima SHALL RICOMINCIARE, e prima della prima
SHALL andare all'ULTIMA. Con UNA sola corrispondenza SHALL restare su quella nei
due versi.

Con ZERO risultati nessun passo SHALL alzare l'indice sopra lo zero.

Un indice FUORI SCALA — il totale è cambiato sotto la barra — SHALL ripartire dal
bordo verso cui si sta andando, non restare fuori scala.

Numeri non finiti NON SHALL produrre un valore illeggibile a schermo. Un totale
che c'è senza che nessuno abbia ancora premuto SHALL leggersi come zero su quel
totale, e niente da trovare come zero su zero.

#### Scenario: il totale cambia sotto la barra
- **GIVEN** un indice oltre il nuovo totale
- **THEN** SHALL ripartire dal bordo verso cui si va

#### Scenario: dopo l'ultima
- **GIVEN** l'ultima corrispondenza e un passo avanti
- **THEN** SHALL tornare alla prima

### Requirement: BROWSER-FAVICON-01 — Il segnaposto di un sito è deterministico e leggibile

Il segnaposto dell'icona di un sito SHALL essere il MONOGRAMMA dell'ospite quando
un ospite c'è, e un simbolo generico quando non c'è: uno schema senza ospite, un
percorso locale, un indirizzo numerico.

L'ospite SHALL essere normalizzato — minuscole, senza il prefisso comune — e una
riga scritta a mano nella barra SHALL essere accettata.

La tinta SHALL essere DETERMINISTICA e derivata dall'ospite, e SHALL restare
entro una luminosità che garantisce la leggibilità su TUTTA la ruota dei colori.

#### Scenario: un indirizzo numerico
- **GIVEN** un ospite senza lettere
- **THEN** SHALL essere disegnato il simbolo generico

#### Scenario: lo stesso sito due volte
- **GIVEN** lo stesso ospite
- **THEN** la tinta SHALL essere la stessa

### Requirement: BROWSER-STATE-01 — Le schede di un task si chiudono in modo MORBIDO, e una chiusura remota arriva VIVA

Chiudere una scheda del navigatore di un task SHALL PARCHEGGIARLA — resta come
anteprima — non distruggerla, e il fuoco SHALL andare alla vicina VIVA allo stesso
posto. Chiudere una già parcheggiata SHALL essere un non-fare; riaprirla SHALL
essere un gesto proprio, distinto dall'attivazione. Una CANCELLAZIONE dura SHALL
esistere ed essere distinta.

Una riapertura decisa da un agente SHALL RISVEGLIARE la parcheggiata invece di
crearne una nuova.

Un titolo scelto dalla PERSONA NON SHALL essere sovrascritto da un titolo
automatico.

Una chiusura arrivata da un ALTRO dispositivo SHALL essere APPLICATA alla vista
viva, non solo scritta: applicarla solo in scrittura è il difetto per cui una
scheda chiusa altrove restava aperta qui.

Le chiavi per-task NON arrivano più nello snapshot iniziale, quindi alla
riconnessione i task IN CACHE SHALL essere RILETTI per applicare le chiusure perse
mentre si era via. Un task MAI aperto NON SHALL essere chiesto — lo copre la
lettura pigra all'apertura. Una scrittura ancora IN CODA SHALL VINCERE: niente
rilettura, l'edit locale resta. Un server vecchio che manda ancora la chiave nello
snapshot NON SHALL far ri-chiedere niente. Una chiave SPARITA dal server NON SHALL
svuotare la cache.

Dimenticare un task SHALL svuotare la cache, avvisare, e ANNULLARE la scrittura in
coda.

Un carico malformato NON SHALL toccare la cache, e un valore IDENTICO NON SHALL
produrre un risveglio.

#### Scenario: una chiusura arrivata da un altro dispositivo
- **GIVEN** una scheda chiusa altrove
- **THEN** SHALL sparire dalla vista viva

#### Scenario: una scrittura ancora in coda
- **GIVEN** una modifica locale non ancora consegnata
- **THEN** NON SHALL essere sovrascritta da una rilettura

### Requirement: BROWSER-STATE-02 — Chi ha aperto cosa, e da dove si riapre

Il legame fra una superficie di navigazione e ciò che l'ha aperta SHALL essere
tenuto nei DUE VERSI, e cambiarne uno SHALL togliere il reciproco vecchio: senza,
il comando che riporta all'origine resta stantio.

Un identificativo di terminale SHALL risolversi alla superficie che ha aperto; in
assenza di traccia SHALL ricadere su sé stesso.

Un navigatore fissato DENTRO un progetto SHALL poter riaprirsi in QUEL progetto
con il suo indirizzo, indipendentemente dal registro limitato delle chiusure
recenti: SHALL esistere un deposito DUREVOLE del suo punto d'origine.

Il deposito NON SHALL essere sporcato da una superficie MORTA: un indirizzo vuoto
o di pagina bianca NON SHALL sovrascrivere un'origine buona. Una scrittura di solo
indirizzo SHALL conservare il titolo precedente.

Il deposito durevole SHALL VINCERE sul registro delle chiusure; in sua assenza
SHALL essere usato il registro; un fissaggio nudo senza nessuna delle due fonti
SHALL essere dichiarato irrecuperabile. La corrispondenza SHALL essere per
identificativo ESATTO della superficie, non per collisione di contesto.

Le code di apertura differita SHALL essere ISOLATE per progetto, SHALL essere
svuotate UNA sola volta, e SHALL DEDUPLICARE — un doppio clic non accoda due
volte.

#### Scenario: un navigatore fissato in un progetto
- **GIVEN** il suo registro delle chiusure già sfrattato
- **THEN** SHALL riaprirsi comunque nel progetto giusto

#### Scenario: una superficie morta
- **GIVEN** una scrittura con un indirizzo vuoto
- **THEN** NON SHALL sovrascrivere l'origine buona

### Requirement: BROWSER-STATE-03 — La cronologia dei siti è FRECENZA, e la griglia racconta il presente

La griglia delle destinazioni SHALL essere ordinata combinando FRESCHEZZA e
FREQUENZA: un sito di ieri visitato poche volte SHALL stare davanti a uno di mesi
fa visitato molte, o la griglia racconta il passato invece del presente. A parità
di freschezza SHALL decidere il numero di visite. Un sito antico NON SHALL valere
zero: resta in coda, non sparisce.

L'ospite SHALL essere NORMALIZZATO, e ciò che non è una destinazione — pagine
interne, errori, file locali — NON SHALL entrare.

Ricaricare lo stesso indirizzo entro una finestra breve NON SHALL essere una
visita nuova; lo stesso indirizzo molto DOPO sì. Navigare DENTRO un sito SHALL
contare, e il riquadro SHALL puntare all'ULTIMA pagina.

I due tetti — pagine e siti — SHALL sfrattare il PEGGIORE, non l'ultimo arrivato.

I dati che arrivano DOPO — titolo, icona — SHALL attaccarsi alla pagina CORRENTE e
NON SHALL essere una visita; il titolo di una pagina che il sito ha GIÀ lasciato
NON SHALL essere scritto.

Dimenticare un sito SHALL portare via anche le sue pagine; svuotare la cronologia
delle pagine SHALL lasciare in piedi i siti.

Lo stato di chrome di una superficie SHALL essere pubblicato PER SUPERFICIE, e una
superficie che cambia NON SHALL toccare l'identità della vicina. Una scheda il cui
pannello non è mai stato montato SHALL leggere «niente», e non è un errore.

#### Scenario: un ricarico
- **GIVEN** lo stesso indirizzo entro la finestra
- **THEN** NON SHALL contare come visita nuova

#### Scenario: una superficie che cambia
- **GIVEN** l'aggiornamento di una sola superficie
- **THEN** l'oggetto della vicina NON SHALL essere ricreato

### Requirement: CLAIM-01 — Il battito di reclamo rivendica ciò che è vivo ADESSO

Il reclamo delle viste native SHALL dichiarare l'etichetta di QUESTA finestra e
gli identificativi delle pane VIVE al momento del battito, non la lista con cui è
stato armato: una pane aperta dopo l'armo resterebbe di nessuno.

Una finestra senza etichetta SHALL reclamare comunque verso la finestra
principale. Nessuna pane montata SHALL reclamare la lista VUOTA, non tacere: il
silenzio non è distinguibile da un battito perso.

Il battito SHALL partire SUBITO e poi ripetersi a intervallo fisso. Armarlo due
volte SHALL essere IDEMPOTENTE e NON SHALL raddoppiare i battiti.

Fuori dal guscio nativo NON SHALL essere invocato niente e NON SHALL essere armato
nessun battito.

Una chiamata nativa che rigetta NON SHALL propagare: il battito si perde, lo si
dichiara, e il giro successivo riprova.

#### Scenario: una pane aperta dopo l'armo
- **GIVEN** un battito armato e una pane montata dopo
- **THEN** il battito successivo SHALL rivendicare anche quella

#### Scenario: fuori dal guscio nativo
- **GIVEN** l'app in un browser normale
- **THEN** NON SHALL essere armato nessun battito

### Requirement: FORGET-02 — «Dimentica questo sito» cancella SOLO quel sito, ed ESATTAMENTE ciò che ha mostrato

Il piano di cancellazione SHALL comprendere il silo registrabile del sito e i
sottodomini che stanno sotto di lui, e NON SHALL comprendere un vicino di casa né
il resto dello store.

Ciò che viene cancellato SHALL essere ESATTAMENTE l'elenco che il dialogo ha
mostrato: i nomi che tornano al nativo sono i nomi elencati, MAI un secondo filtro
applicato dopo. Un dialogo che mostra una lista e ne cancella un'altra è una
promessa rotta che nessuno può vedere.

Le voci SHALL essere nominate per esteso e ordinate per GRAVITÀ, uniche. Un tipo
di dato sconosciuto SHALL finire fra i dati del sito, NON SHALL sparire in
silenzio. Senza sessione salvata NON SHALL comparire una riga che promette di
cancellarla.

La costruzione del piano SHALL LEGGERE lo store senza toccarlo.

Una pane vuota, uno store illeggibile, o un errore del server SHALL produrre un
piano VUOTO — quindi nessun tasto che promette — non una promessa a vuoto. Una
lista vuota NON SHALL chiamare il nativo.

Per lo store CONDIVISO NON SHALL comparire una riga per ciò che non è per-sito, e
il contesto SHALL finire nella URL correttamente codificato, mai concatenato a
mano. Un motore esterno SHALL essere dichiarato «non li teniamo noi», che è
diverso da «non c'è niente».

#### Scenario: un vicino di casa
- **GIVEN** un dominio che condivide un prefisso ma non il silo
- **THEN** NON SHALL entrare nel piano

#### Scenario: lo store non si legge
- **GIVEN** uno store illeggibile
- **THEN** il piano SHALL essere vuoto, e nessun tasto SHALL promettere una cancellazione

### Requirement: HISTORY-01 — La cronologia è UNA, per quante sorgenti abbia

Le righe della cronologia SHALL uscire dello STESSO tipo qualunque sia la
sorgente — tab chiuse e pagine visitate — e SHALL essere mescolate per TEMPO, dal
più recente. Se una delle due tornasse a viaggiare per conto suo, questi casi
diventano rossi prima che chi guarda la lista se ne accorga.

Una pagina senza titolo SHALL presentarsi con il proprio indirizzo, accorciato.
Una tab chiusa SHALL portare con sé il proprio indirizzo.

La ricerca SHALL richiedere TUTTE le parole, anche quando cadono in campi diversi.

Il tetto SHALL essere applicato DOPO l'ordinamento, mai prima: tagliare prima
sceglie a caso.

Senza sorgenti SHALL uscire un elenco vuoto, non un errore.

#### Scenario: due sorgenti
- **GIVEN** tab chiuse e pagine visitate con istanti intrecciati
- **THEN** SHALL uscire un solo elenco ordinato per tempo

#### Scenario: il tetto
- **GIVEN** più righe del tetto
- **THEN** SHALL essere tagliato dopo l'ordinamento

### Requirement: TINT-01 — La tinta di un'icona esce dai suoi pixel, e il contrasto si misura sul COMPOSITO

Il colore dominante di un'icona SHALL essere ricavato dai pixel, ignorando i
trasparenti e i grigi: i grigi non sono identità, e un'icona monocroma o vuota
SHALL produrre NESSUNA tinta, non una tinta sbagliata. Lo spicchio più PESANTE
SHALL vincere, non il primo incontrato, e il risultato SHALL essere
DETERMINISTICO.

La conversione da e verso la forma esadecimale SHALL annullarsi, SHALL tollerare
la forma corta e gli ingressi storti, e SHALL SATURARE invece di sbordare.

La luminanza SHALL usare la spezzata dello spazio colore standard, non una
potenza approssimata. Il contrasto SHALL essere simmetrico, con bianco e nero ai
due estremi.

**Il rapporto di contrasto SHALL essere calcolato sul colore che si VEDE**, cioè
sul composito della tinta sulla superficie, non sulla tinta pura: una tinta al
ventidue per cento non porta con sé la luminanza della tinta piena, e misurarla lì
promette una leggibilità che non c'è. L'opacità fuori scala SHALL essere
ristretta.

La scelta fra i due toni di testo SHALL restituire sempre il MIGLIORE dei due —
mai un valore predefinito — e SHALL RIPORTARE il rapporto quando nessuno dei due
basta, invece di nasconderlo.

La palette per spicchi SHALL rispecchiare DOVE il colore sta nell'icona, e uno
spicchio vuoto SHALL ereditare il vicino invece di spegnersi.

#### Scenario: una tinta trasparente su una superficie
- **GIVEN** una tinta applicata a bassa opacità
- **THEN** il rapporto SHALL essere calcolato sul composito

#### Scenario: un'icona monocroma
- **GIVEN** un'icona di soli bianco e nero
- **THEN** NON SHALL essere prodotta nessuna tinta

### Requirement: OCCLUSION-01 — Una vista nativa si congela quando qualcosa la COPRE davvero

Una vista nativa SHALL essere considerata coperta quando un pannello sovrapposto
INTERSECA la sua area. Il contatto sul solo bordo, con area di sovrapposizione
nulla, NON SHALL contare; un pannello lontano NON SHALL contare; un'area nulla NON
SHALL essere mai coperta; e senza pannelli NON SHALL esserci copertura. Uno
qualunque fra più pannelli SHALL bastare.

Ogni superficie che può stare sopra — la card di un modale, un menu contestuale, i
contenitori dei menu — SHALL portare il marcatore di copertura. **Il velo di
sfondo NON SHALL essere la superficie**: conta la card, non il velo.

Un pannello che sta ENTRANDO SHALL contare anche se la sua opacità è ancora zero,
perché un fotogramma dopo copre già. Un elemento fermo a zero — un comando di riga
in attesa del passaggio del mouse — NON SHALL contare. Un elemento non disegnato o
nascosto NON SHALL contare, nemmeno mentre un'animazione gira.

Senza un rettangolo noto e con un pannello aperto la vista SHALL congelarsi lo
stesso: nel dubbio si congela. Senza rettangolo e senza pannelli NON SHALL
congelarsi niente.

Chi si iscrive SHALL ricevere SUBITO lo stato corrente. Una pane che si APRE, e
una che TORNA visibile, SHALL chiedersi subito se il proprio posto è già coperto.

#### Scenario: due rettangoli che si toccano sul bordo
- **GIVEN** un pannello adiacente alla vista, senza sovrapposizione
- **THEN** NON SHALL contare come copertura

#### Scenario: un modale che sta entrando
- **GIVEN** un pannello in animazione di ingresso, opacità ancora nulla
- **THEN** SHALL contare come copertura

### Requirement: NATIVEOPS-01 — Le operazioni del browser nativo o si mappano, o dicono perché no

Ogni operazione del browser SHALL avere una mappatura nativa dichiarata, e quelle
prive di mappatura SHALL restituire un suggerimento STRUTTURATO — che quella
operazione vive in modalità flusso — SENZA invocare niente. Un'operazione che
tace è indistinguibile da una che ha fallito.

La lettura del testo SHALL rispettare un tetto e, con un riferimento, SHALL
restringersi all'elemento osservato. L'osservazione SHALL serializzare nel formato
condiviso, e la forma incrementale SHALL confrontarsi con l'istantanea
precedente.

L'azione SHALL restituire la differenza successiva all'azione, e SHALL RIFIUTARE —
senza invocare — un'azione per riferimento priva di riferimento e un'azione
sconosciuta. Un risultato nativo fallito SHALL emergere come ERRORE, non come
successo silenzioso.

L'estrazione SHALL richiedere i campi. Lo scatto di schermo SHALL tornare nella
forma compatibile con il flusso.

Il salvataggio dello stato di accesso SHALL leggere il barattolo dei cookie della
pane e la memoria locale dell'origine corrente, e SHALL TOLLERARE un barattolo
malformato: nessun cookie, ma la memoria locale esce lo stesso. Il caricamento
SHALL applicare cookie e memoria per origine e SHALL tornare alla pagina di
partenza, con un ripiego cookie-per-cookie quando il blocco viene rifiutato. Senza
uno stato risolto dal server SHALL essere un errore STRUTTURATO.

Una chiamata nativa che solleva SHALL essere catturata e riportata come errore
strutturato.

#### Scenario: un'operazione senza mappatura nativa
- **GIVEN** un'operazione che il guscio non implementa
- **THEN** SHALL tornare un suggerimento strutturato, senza invocare niente

#### Scenario: un barattolo di cookie malformato
- **GIVEN** un dump illeggibile
- **THEN** i cookie SHALL mancare, e la memoria locale SHALL uscire lo stesso

### Requirement: ZOOM-01 — Lo zoom vive su una SCALA, e sopravvive a una navigazione

I livelli di zoom SHALL formare una scala di percentuali INTERE, strettamente
crescente, con il valore predefinito SULLA scala.

Il movimento SHALL essere di UNO scatto per gesto, e SHALL dipendere solo dal
SEGNO dell'incremento: la tastiera e i bottoni SHALL muoversi allo stesso modo.
Agli estremi SHALL essere ristretto. Un valore FUORI scala — ereditato o
persistito — SHALL essere agganciato al più vicino PRIMA di muoversi, e il
risultato NON SHALL MAI uscire dalla scala, qualunque cosa arrivi in ingresso.

**Lo zoom SHALL sopravvivere a una navigazione.** Un documento appena caricato che
non dichiara zoom vale cento per cento; un documento che ha PERSO lo zoom è
DERIVATO, ed è tutto il difetto. Entrambe le grafie della proprietà SHALL essere
rilette; un valore illeggibile SHALL valere neutro, non un numero. Il rumore di
virgola del giro attraverso una stringa NON SHALL essere scambiato per deriva, e
il caso comune — cento per cento su un documento fresco — NON SHALL costare
niente.

Il codice applicato SHALL fare il giro attraverso il proprio lettore per OGNI
passo, e NON SHALL poter sollevare verso il chiamante.

#### Scenario: una pagina che ha perso lo zoom
- **GIVEN** una navigazione dopo la quale il documento non porta più lo zoom
- **THEN** SHALL essere riconosciuta come deriva

#### Scenario: un valore fuori scala
- **GIVEN** un valore persistito che non sta sulla scala
- **THEN** SHALL essere agganciato al più vicino prima di muoversi
