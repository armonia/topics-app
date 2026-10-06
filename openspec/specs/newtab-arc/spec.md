# newtab-arc Specification

## Purpose

The empty browser tab behaves like Arc's: the field takes the focus on open,
typing filters local suggestions (open tabs, recent pages, top sites,
commands), and submitting classifies — a url navigates, a `/command` suggests,
a long text offers a note in the topic's project folder. The address bar and
the tab sheet are untouched: they only share their sources with this page.

New file rather than a section of `remote-browser`, decided in change
`newtab-arc`: the four requirements below are the page's whole contract, and
they read better together than scattered across the browser's navigation,
agent-interaction and rendering requirements.

## Requirements

### Requirement: NEWTAB-ARC-01 — The field takes the focus and typing suggests

When an empty browser tab opens, the new-tab field SHALL hold the keyboard
focus, including against the tab sheet the fresh pane auto-opens on the
address (TOPIC-BROWSER-02): a focus that lands inside that sheet returns to
the field until the first key or pointer press retires the guard. Typing SHALL
filter suggestion rows under the field; while the query is non-empty the rows
replace the top-sites grid.

#### Scenario: a fresh tab focuses its field
- **GIVEN** a browser pane with no url
- **WHEN** its new-tab page appears
- **THEN** `document.activeElement` SHALL be the new-tab field, and the auto-opened sheet SHALL still be visible beside it

#### Scenario: typing filters rows
- **GIVEN** the new-tab page with open tabs and history behind it
- **WHEN** a query matching them is typed
- **THEN** at least one non-empty suggestion section SHALL show, and the grid SHALL be hidden

### Requirement: NEWTAB-ARC-02 — Four sections from shared sources, no duplicates

The rows SHALL group into open browser tabs (from the pane store), recent
pages (the global page history), top sites (the ranked sites the grid reads)
and commands (the existing slash commands), each capped at five, each drawn
with the same row component the tab sheet uses. A url already shown higher
SHALL NOT repeat below: tabs win over recent, both win over top. The top
section SHALL stay hidden while the query is empty, where the grid already
says it. A tab row SHALL focus that tab; a recent or top row SHALL navigate.

#### Scenario: two tabs plus history show every section
- **GIVEN** two open browser tabs, visited pages and ranked sites
- **WHEN** the new-tab page opens
- **THEN** the tabs, recent and commands sections SHALL show with their rows, and the grid SHALL show the top sites

#### Scenario: a url opens in one place only
- **GIVEN** a url that is both an open tab and a history row
- **WHEN** the new-tab page suggests
- **THEN** that url SHALL appear exactly once, in the tabs section

### Requirement: NEWTAB-ARC-03 — A submit classifies to url, command or note

Submitting SHALL classify in this order: a `/name` attempt (one token, no dot,
no second slash) is a command — known or not, it fills back into the field and
SHALL NOT navigate; a multiline text, or one over 500 characters, offers the
note door; anything else navigates under `toNavigableUrl`, the bar's own rule.
A local path (`/Users/x/doc.pdf`) SHALL navigate, never read as a command.

#### Scenario: a bare host navigates
- **GIVEN** the new-tab field
- **WHEN** `esempio.it` is submitted
- **THEN** the pane SHALL navigate to `https://esempio.it`

#### Scenario: a command suggests instead of navigating
- **GIVEN** the new-tab field
- **WHEN** `/status` is typed
- **THEN** a command row SHALL show, and picking it SHALL fill the field while the tab stays a new tab

#### Scenario: a long text offers a note
- **GIVEN** the new-tab field of a topic with a project folder
- **WHEN** a 600-character text is typed
- **THEN** a create-note row SHALL show with the note's file name

### Requirement: NEWTAB-ARC-04 — The note lands in the project and opens in the editor

Picking the create-note row (or submitting the long text) SHALL write the text
verbatim into a `.md` note in the current topic's project folder — a slug of
its first line, suffixed while the name is taken — and SHALL open it in an
editor tab showing the same content. The note is a draft, never committed;
deleting it SHALL remove it from the project. Without a project folder the row
SHALL NOT show and the text SHALL submit as an address.

#### Scenario: a note is created, opened and deleted
- **GIVEN** a 600-character text in the new-tab field of a project topic
- **WHEN** the create-note row is picked
- **THEN** an editor SHALL open showing the same text
- **WHEN** the note is deleted
- **THEN** it SHALL be gone from the project folder
