## Purpose

How the non-chat panes (board, diff panel, lazy panes, Git section, terminal,
browser) load and move: what is on screen while they wait, and which motions
are allowed while they arrive. Every requirement here comes from the fluidity
audit of 2026-09-29 (findings panes:F6-F16), was reproduced frame by frame on
the build before the fix, and is held by a Playwright contract that samples
every animation frame (`tests/e2e/helpers/frame-probe.ts`).

Shared rules: only `transform` and `opacity` animate, on the tokens of
`client/src/lib/motion.ts`; reduced motion turns every such animation off; a
placeholder has the geometry of what replaces it; nothing that was instant
gets slower.

## Requirements

### Requirement: PANELOAD-01 — Opening and closing a board card does not move the board

The task drawer SHALL enter with a short opacity and translate animation
(`MOTION.fast`) and SHALL stay mounted while it leaves, fading out on the exit
curve. Its presence changing the columns row's width SHALL NOT move the columns:
the carousel snap is held across the change and resumes at the next scroll
gesture on the row. The status chip SHALL show the status the board already
holds on the drawer's first frame. Under reduced motion the drawer SHALL appear
and disappear without animation.

#### Scenario: open and close a card on a board wider than the pane
- **GIVEN** a board whose five columns overflow the row
- **WHEN** a card is opened and the drawer closed with Escape
- **THEN** the Todo column SHALL not move sideways, the drawer SHALL fade in and out, and the chip SHALL not change width

### Requirement: PANELOAD-02 — The board loads behind a skeleton with its geometry

While the board chunk and its first read are on the way, the pane SHALL show a
skeleton of the toolbar and the five columns built from the same classes as the
real columns (`boardGeometry.ts`), and the board SHALL replace it with its fade.

#### Scenario: a slow board chunk
- **GIVEN** the board chunk takes 700 ms to arrive
- **WHEN** the board pane opens
- **THEN** the skeleton SHALL cover every frame until the board, and its Todo column SHALL sit where the real one lands

### Requirement: PANELOAD-03 — Drops and filters move nothing by layout

The drop-redirect notice SHALL float over the columns instead of pushing them.
It SHALL cover no column header and not the task composer, SHALL take no
pointer input, and SHALL leave by itself after a few seconds.
A filter that changes the Review column's width SHALL NOT animate a layout
property: the columns it shifts SHALL glide with a transform. The sortable
reflow of the cards under a drag SHALL run on `MOTION.base` with the standard
curve, and SHALL NOT run under reduced motion.
While a card is in hand the columns row SHALL NOT snap: the auto-scroll near its
edge SHALL move the row by pixels, never a column at a time, and the drop SHALL
land on the column under the pointer.

#### Scenario: a card carried to the row's edge
- **GIVEN** a card in hand, resting inside the auto-scroll band at the row's right edge, under reduced motion
- **WHEN** the row auto-scrolls to its end and the card is dropped on Done
- **THEN** the row SHALL carry no scroll snap while the card is in hand, and SHALL still auto-scroll towards that edge
- **AND** the card SHALL land on Done, the column under the pointer

#### Scenario: a redirected drop, then a filter that empties Review
- **GIVEN** a card dragged onto In progress and dropped
- **WHEN** the notice appears and a filter empties Review
- **THEN** the columns SHALL not move vertically, and no layout property SHALL animate
- **AND** the notice SHALL overlap no column header and not the composer, and SHALL be gone without another gesture

### Requirement: PANELOAD-04 — The diff panel keeps its breadcrumb and its content while files are switched

Opening a file's diff SHALL show the breadcrumb and an editor-shaped skeleton
until the diff is read; the diff, its hunk strip and the viewer's chunk SHALL
land in one commit. Switching to another file SHALL keep the previous file on
screen, read-only with a spinner in the breadcrumb, until the next one is read,
also when the preview pane is replaced by a new one.

#### Scenario: three files of a review in a row
- **GIVEN** the Git section of a project with changed files
- **WHEN** three files are opened one after the other
- **THEN** no frame SHALL lack the breadcrumb or the diff, and each switch SHALL move the diff at most once

### Requirement: PANELOAD-05 — A lazy pane waits as itself

A lazy pane with a skeleton of its own (board, dashboard, profile, file editor)
SHALL show it as the Suspense fallback instead of the ring, with the pane's
layout classes, so the content lands where the placeholders stood.

#### Scenario: a slow dashboard chunk
- **GIVEN** the dashboard chunk takes 700 ms to arrive
- **WHEN** the dashboard pane opens
- **THEN** the skeleton's KPI grid and chart SHALL match the real ones within 2 px

### Requirement: PANELOAD-06 — The Git section opens once

Opening the project's Git section SHALL grow it once, to within a few pixels of
the height it keeps: while the panel's chunk is on the way the section SHALL
show skeleton rows sized on the number of changed files, and the chunk SHALL be
asked for as soon as the pointer is on the section's row.

#### Scenario: a cold click on the Git row
- **GIVEN** the Git panel's chunk is not loaded
- **WHEN** the section is opened
- **THEN** its height after the first change SHALL be within 12 px of its final height

### Requirement: PANELOAD-07 — A terminal paints its first frame at the pane's size

The terminal SHALL be fitted to its pane in the same task that opens it, so no
frame shows xterm at its default 80x24.

#### Scenario: attaching a terminal pane
- **GIVEN** a terminal session in the pane store
- **WHEN** the app loads
- **THEN** the first painted terminal screen SHALL have the pane's final size

### Requirement: PANELOAD-08 — A browser pane opened on a URL does not flash the New Tab page

While a browser pane has a destination it has not reached (a navigation not yet
consumed, or a known URL within a short grace), it SHALL show the loader, not
the New Tab page. An empty pane with no known URL SHALL still show the New Tab
page at once.

#### Scenario: opening a browser on a link
- **GIVEN** a chat pane
- **WHEN** a browser is opened on a URL
- **THEN** the New Tab page SHALL never appear
