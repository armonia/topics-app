## ADDED Requirements

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
