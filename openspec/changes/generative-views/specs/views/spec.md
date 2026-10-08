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

### Requirement: GENUI-06 — A table view for rows read across columns

`show_view` SHALL accept `view: "table"`: 1-8 columns and 1-40 rows, cells
string, number or null. A short row SHALL be padded with nulls, a longer row
refused. A column MAY declare `format` (`duration`: minutes read as "3 h 19";
`price`: an amount in the column's currency) and `better`; the best value of a
ranked column SHALL be marked, ties sharing it, all-equal ranking nobody. A
null SHALL read as unknown ("n/d"), never as a guess. At most one row is
`recommended`. Wide, it SHALL be a table with numbers right-aligned on one
edge; at a narrow container (chat column, phone) a card per row, with nothing
to pan sideways.

#### Scenario: her trains, Huesca to Sants
- **GIVEN** the AVE 08:05 → 11:24 (price unknown), the train via Zaragoza (3 h, 22,30 €) and the Avanza bus 16:30 (3 h 50, 12,70 €)
- **WHEN** the table is shown
- **THEN** the AVE row is recommended, 3 h and 12,70 € are marked best, the AVE price reads "n/d"
- **AND** at 390 px each train is a card and the page does not pan sideways

### Requirement: GENUI-07 — A timeline view for a plan in order

`show_view` SHALL accept `view: "timeline"`: 1-24 steps with title and,
optionally, `day`, `time` (HH:MM, else a written error), `mode`, `duration`,
`price`, `detail`, `link`, `deadline` and up to 3 `alternatives` for the same
leg. Consecutive steps of the same day SHALL be drawn under one heading, times
on one column edge, a deadline as a limit.

#### Scenario: his door to door plan
- **GIVEN** landing at T1 16:00, bus 1149 at 16:50 (32 min, 9,25 €) or a taxi at 47-53 €, and Wednesday back to T2 for easyJet U24212 at 14:10
- **WHEN** the timeline is shown
- **THEN** it has two days and six steps, the taxi is the alternative of the bus leg, 12:40 is drawn as the deadline

### Requirement: GENUI-08 — The same views in any MCP Apps host

The MCP bridge SHALL declare the `resources` capability and expose the views
as MCP Apps resources (`text/html;profile=mcp-app`): `ui://topics/view`, a
generic app, and `ui://topics/view/<id>`, one stored view, listed by
`resources/list` and `resources/templates/list` and read by `resources/read`
(an unknown id answers -32002). `show_view` SHALL carry
`_meta.ui.resourceUri = "ui://topics/view"`, and its result SHALL carry the
drawn view in `_meta["topics/view"]`, not in the text the model reads. Each
document SHALL be self-contained (own CSS, escaped data, https photos declared
in `_meta.ui.csp.resourceDomains`, allowed local photos inlined within a
budget), speak the MCP Apps postMessage protocol (`ui/initialize`, host theme
and colour variables, `size-changed`, links through `ui/open-link`) and pass
axe.

#### Scenario: a host renders the plan the bridge returned
- **GIVEN** the real bridge process and a sandboxed host frame answering `ui/initialize` with a dark theme
- **WHEN** the host calls `show_view`, reads `ui://topics/view` and posts the tool result
- **THEN** the frame shows six steps in the host's colours, reports its height, and a link click reaches the host as `ui/open-link`
