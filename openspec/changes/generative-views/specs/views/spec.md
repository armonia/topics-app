# Views — the agent sends data, Topics draws it

## ADDED Requirements

### Requirement: GENUI-01 — A view is a block of the chat that stays in sight

A successful `show_view` call SHALL render as a view block in the assistant
message, lifted out of the turn's fold like an opened page, at the full width
of the chat column. The block SHALL carry a link that opens the same view as a
page. A failed call SHALL render as an ordinary tool row.

#### Scenario: three stays compared in the chat
- **GIVEN** a turn with three Bash calls, a `show_view` compare of 3 options and a text verdict
- **WHEN** the chat renders it
- **THEN** the fold counts 3 actions, the view block is visible inside the bubble, the cards do not overlap
- **AND** the gallery advances one photo per click and the block passes axe

### Requirement: GENUI-02 — `show_view` stores the view and answers with its page

`show_view` SHALL be a tool of the MCP bridge and of the native runtime.
`POST /api/sessions/:sessionKey/views` SHALL normalise the spec, store it as
`data/views/<id>.json` (id: 16 hex chars) and answer 201 `{id, path, spec}`;
an invalid spec SHALL answer 400 with every error, a body over 256 KB 413.
`GET /api/views/:id` SHALL return the stored spec, or 404.

#### Scenario: the tool answer names the page
- **WHEN** the agent calls `show_view` with a valid compare
- **THEN** the answer reads `shown in chat · compare · N options · page <base>/v/<id>`

### Requirement: GENUI-03 — The contract is a typed catalog, not markup

A view SHALL be one of the catalog kinds (today `compare`, 2-4 options, at most
one `recommended`). Prices given as text SHALL be parsed to amount and
currency; images SHALL be https, absolute paths or `file://`; links SHALL be
https. Numeric metrics with the same label SHALL be ranked best and worst
across options; ties share the rank, all-equal values rank nobody, text values
are not ranked.

#### Scenario: a malformed compare is refused with every reason
- **WHEN** a compare has 5 options, two `recommended` and an option without title
- **THEN** normalisation fails listing all three errors

### Requirement: GENUI-04 — The same view is a page, on desktop and phone, in both themes

`/v/<id>` SHALL render the stored view with the app's design system, outside
the app shell, in light and dark. On desktop the cards SHALL sit on one row,
equal widths, with their sections aligned across cards. At 390 px the cards
SHALL become a horizontal strip with the next card visibly cut by the edge,
and the page itself SHALL NOT pan sideways. Links SHALL be at least 36 px
tall. The page SHALL pass axe. An unknown id SHALL show a not-found state.

#### Scenario: the stays page on a phone
- **GIVEN** the view of the three Sitges stays
- **WHEN** it opens at 390 px wide in dark mode
- **THEN** the second card is cut by the right edge, the body does not scroll sideways, axe reports nothing

### Requirement: GENUI-05 — One browser window per chat, children included

Opens of `open_browser_pane` from the same chat SHALL share one browser
context whatever `name` they pass. An open from a `spawn_agent` child SHALL
keep the child's own context and SHALL be announced with `hostTopicId`, the
chat at the top of its spawn chain; the client SHALL place it as a sheet of
that chat's browser window, and the layout SHALL gain no browser tab.

#### Scenario: a child opens a page while the parent chat is on screen
- **GIVEN** the parent chat on screen, which opened two pages named «Nautilus» and «El Cid»
- **WHEN** its child opens a page named «Terza opzione»
- **THEN** the parent's window shows 2 sheets (its own and the child's) and no `browser:` pane exists in the layout
