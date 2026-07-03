## ADDED Requirements

### Requirement: NATIVE-BROWSER-AGENT-01 — Agent DOM control on the visible native pane

On the desktop app's **native browser pane** (a system webview the server cannot
reach via CDP — e.g. Tauri's WKWebView), the agent SHALL be able to drive the
**visible** pane (the one the user sees), not a separate hidden browser, for the
core DOM-interaction tools: `browser_observe`, `browser_act`, `browser_extract`,
and ref-scoped `browser_get_text`.

These tools SHALL be executed by injecting page-context JavaScript through the
existing native eval bridge (no CDP). `browser_observe` SHALL return the SAME
result shape and SAME serialized snapshot / incremental-diff text format as the
CDP/Playwright path (`{url, title, count, snapshot, full}`), produced from a
single shared snapshot core so the format cannot drift. `browser_act` SHALL
support `click, dblclick, hover, fill, type, select, check, uncheck, press,
scroll, get_text`, resolve the target by the `data-topics-ref` marker stamped by
the latest observe, and return `{ok, action, ref, snapshot}` with an incremental
diff. The agent tool schema (`browser-tool-spec.ts`) SHALL remain unchanged so
the native and streaming panes are interchangeable to the caller.

A known limitation SHALL be documented: native actions dispatch synthetic
(non-trusted) DOM events, unlike the Electron CDP path's trusted input.

#### Scenario: Agent observes the visible native pane and acts by ref

- **GIVEN** a native browser pane open on a page the user can see
- **WHEN** the agent calls `browser_observe`
- **THEN** it receives a ref-based snapshot in the identical format used on the
  CDP path (header + `[N] role "name"` lines)
- **AND** when the agent then calls `browser_act` with `{ref, action:"click"}`
  the element carrying `data-topics-ref="N"` is clicked on the **visible** pane
- **AND** the response includes an incremental diff of what changed

#### Scenario: Stale ref fails clearly

- **GIVEN** the page changed after the last `browser_observe`
- **WHEN** the agent calls `browser_act` with a ref that no longer exists
- **THEN** the call fails with a message telling the agent to call
  `browser_observe` again, identical to the CDP path's behaviour

#### Scenario: extract and ref-scoped get_text on the native pane

- **GIVEN** a native browser pane on a content page
- **WHEN** the agent calls `browser_extract` with a CSS-selector field map
- **THEN** it returns `{extracted}` with each field read from the visible page
- **AND** `browser_get_text` with a `ref` returns that element's text (not the
  whole document)

### Requirement: NATIVE-BROWSER-AGENT-02 — Agent vision on the native pane

On the native browser pane, `browser_read_screen` and `browser_point` SHALL
operate on the **visible** pane by capturing the existing native screenshot and
running the existing server-side vision layer (caption / locate) on it, rather
than returning a "enable streaming" error.

#### Scenario: Agent reads the screen of the native pane

- **GIVEN** a native browser pane the user can see
- **WHEN** the agent calls `browser_read_screen`
- **THEN** the server captures the native pane screenshot and returns a vision
  description of what is on screen

#### Scenario: Agent points-and-clicks by description on the native pane

- **GIVEN** a native browser pane showing a labelled control
- **WHEN** the agent calls `browser_point` with a description of that control
- **THEN** the control's location is resolved from the native screenshot and a
  click is performed at that location on the visible pane

### Requirement: NATIVE-BROWSER-AGENT-03 — Agent login-state portability on the native pane

On the native browser pane, `browser_save_state`, `browser_load_state`, and
`browser_import_chrome` SHALL operate on the **visible** pane: cookies via a
native cookie-store bridge plus `localStorage` via page eval. `browser_import_chrome`
SHALL reuse the existing server-side Chrome cookie extraction and apply the
cookies through the native bridge (no credential decryption in the desktop shell).

#### Scenario: Agent saves and restores login state on the native pane

- **GIVEN** a native browser pane logged in to a site
- **WHEN** the agent calls `browser_save_state`
- **THEN** it receives a handle capturing the pane's cookies and localStorage
- **AND** calling `browser_load_state` with that handle on a fresh pane restores
  the session so the site is logged in

### Requirement: NATIVE-BROWSER-04 — Native pane navigation & permission hardening

The native browser pane SHALL match the Electron pane's navigation and permission
safeguards: (a) a per-pane navigation scheme-guard that blocks non-web schemes
(`file:`, `chrome:`, `view-source:`) for page- and agent-initiated navigation;
(b) a permission path that surfaces camera/microphone/geolocation requests to the
existing Permission bar with Allow/Deny; (c) `window.open`/`window.close` handling
so OAuth/wizard popups redirect in-place and `window.close()` closes the pane; and
(d) a populated back/forward history dropdown sourced from the native
back-forward list.

#### Scenario: Scheme-guard blocks file:// on the native pane

- **GIVEN** a native browser pane
- **WHEN** a page- or agent-initiated navigation targets `file:///etc/passwd`
  (e.g. via `browser_eval` setting `window.location`)
- **THEN** the navigation is blocked, matching the Electron `guardNav` policy

#### Scenario: Permission request surfaces a prompt on the native pane

- **GIVEN** a site in the native pane requests camera or microphone access
- **WHEN** the request is made
- **THEN** the Permission bar shows an Allow/Deny prompt and the user's choice is
  honoured (default-deny if dismissed)

#### Scenario: window.close() closes the native pane

- **GIVEN** a native pane on an OAuth flow that calls `window.close()`
- **WHEN** the page invokes close
- **THEN** the pane closes, matching the Electron close-sentinel behaviour

#### Scenario: Back/forward history dropdown is populated

- **GIVEN** a native pane that has navigated across several pages
- **WHEN** the user opens the back/forward history dropdown
- **THEN** it lists the navigable history entries and selecting one navigates to it
