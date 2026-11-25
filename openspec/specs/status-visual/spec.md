# status-visual Specification

## Purpose

One colour and one icon per meaning across the app. Four states exist: `wait`
(amber, something waits for you), `working` (sky blue, the same as the
in_progress column), `danger` (red, failed, stopped or errored) and `ok`
(emerald, done or healthy). Their tokens live in `client/src/lib/statusVisual.ts`,
one per surface: `STATUS_DOT` for dots and glyphs, `STATUS_INK` for text,
`STATUS_CHIP` for tinted chips, and `STATUS_ICON` for the glyph of each state.
Rose is the colour of the Review column and is not a state.

## Requirements

### Requirement: STATUS-VISUAL-01 — Same meaning, same colour; rose is not a state

The system SHALL draw every status from the table in `lib/statusVisual.ts`, so that
the same meaning has the same colour and glyph on the Board, in the sidebar, in the
Agents pane, in Processes and in Settings. Rose SHALL appear only as the Review
column colour and SHALL NOT express any state.

#### Scenario: a meaning keeps its colour from one surface to another
- **GIVEN** a task awaiting the person, an agent at work and a failed dispatch
- **WHEN** they are shown on the Board card, in the task detail, in the sidebar and in the Agents pane
- **THEN** "awaiting you" is amber with `CircleAlert`, "working" is sky blue and "failed" is red on every one of them
- **AND** no state is drawn in rose

### Requirement: STATUS-VISUAL-01a — Four states, one token per surface

The table SHALL hold exactly the four states `wait`, `working`, `danger` and `ok` in
`STATUS_DOT`, `STATUS_INK`, `STATUS_CHIP` and `STATUS_ICON`. Each class of a token
SHALL belong to its state's own family (amber, sky, red, emerald), each chip SHALL use
the `-500/15` veil of that family, and `STATUS_ICON.wait` SHALL be `CircleAlert`.
`STATUS_ICON` SHALL be declared `as const satisfies Record<StatusTone, LucideIcon>`,
so a misspelled key does not compile.

#### Scenario: the table is complete and in its own families
- **GIVEN** the exports of `lib/statusVisual.ts`
- **WHEN** their keys and classes are read
- **THEN** each table has the four states and each class names the state's family
- **AND** no token contains rose or pink

### Requirement: STATUS-VISUAL-01b — Every token clears WCAG on the real grounds

Measured against the chrome (`--chrome-bg`) and the card (`--bg-elevated`) of
`index.css`, in both themes, a `STATUS_DOT` SHALL reach 3:1, a `STATUS_INK` SHALL reach
4.5:1, and the text of a `STATUS_CHIP` SHALL reach 4.5:1 on its veil composited over the
card.

#### Scenario: a token moved under its threshold
- **GIVEN** the oklch steps of the Tailwind theme converted to sRGB
- **WHEN** a token is changed to a step that measures under its threshold on one ground
- **THEN** the test fails naming the token, the ground and the theme

### Requirement: STATUS-VISUAL-01c — The docblock prints measured numbers

The contrast tables in the docblock of `lib/statusVisual.ts` SHALL equal, to two
decimals, the numbers computed from the Tailwind theme for the tokens the module exports.

#### Scenario: a remembered number instead of a measured one
- **GIVEN** the docblock row `amber-700/400` for the dots
- **WHEN** its dark chrome number reads 11.87 while the computation gives 11.52
- **THEN** the test fails on that row

### Requirement: STATUS-VISUAL-01d — The chrome signals and the popover inks are aliases

`SEGNALE_ATTESA` and `WARNING_TEXT` SHALL both be `STATUS_INK.wait`; `SEGNALE_GUASTO`
and `DANGER_TEXT` SHALL both be `STATUS_INK.danger`; `SEGNALE_OK`, `PALLINO_OK` and
`PALLINO_ATTESA` SHALL be `STATUS_INK.ok`, `STATUS_DOT.ok` and `STATUS_DOT.wait`. The
source of `chromeSignals.ts` and `popoverStyles.ts` SHALL NOT spell those pairs again.

#### Scenario: the two names of one colour
- **GIVEN** `chromeSignals.ts` and `popoverStyles.ts`
- **WHEN** their warning and danger exports are compared with the table
- **THEN** they are the same strings, defined by reference to `STATUS_INK`

### Requirement: STATUS-VISUAL-01e — "Awaiting you" is amber with CircleAlert

`DISPATCH_CHIP.needs_input` SHALL use `STATUS_CHIP.wait` and `STATUS_ICON.wait`. The
Board card chip and the Processes session chip with key `board.card.awaitingYou` SHALL
use `STATUS_CHIP.wait` and draw `STATUS_ICON.wait`. The lit count of the Board row in the
sidebar SHALL draw `STATUS_ICON.wait` in `STATUS_INK.wait`. The sidebar `needs-you`
section and the mobile waiting door SHALL use `STATUS_ICON.wait`.

#### Scenario: rose comes back on needs_input
- **GIVEN** the `needs_input` entry of `DISPATCH_CHIP`
- **WHEN** its class is set back to a rose chip
- **THEN** the wiring test fails

### Requirement: STATUS-VISUAL-01f — "Working" is sky blue, never green

The `working` entries of the Agents pane (`DOT`, `TEXT` and the group count), of
`AgentLines` (`SIGNALS.working.tint`), of `AgentsRow` and of the sidebar sub-agents dot
SHALL use `STATUS_DOT.working` or `STATUS_INK.working`, and `DISPATCH_CHIP.working`
SHALL use `STATUS_CHIP.working`. None of them SHALL use a green token or `STATUS_*.ok`.

#### Scenario: an agent at work drawn green
- **GIVEN** the `working` entry of `SIGNALS` in `AgentLines.tsx`, written over several lines
- **WHEN** its `tint` is set to `STATUS_INK.ok`
- **THEN** the wiring test fails

### Requirement: STATUS-VISUAL-01g — Failures are the danger red on card and detail

`DISPATCH_CHIP.failed`, the card's action error, not-landed chip, red checks chip,
stopped chip and unattended sub-task chip, and the detail's action error, not-landed
banner, stopped chip, unattended work chips and load error SHALL use `STATUS_CHIP.danger`,
`STATUS_INK.danger` or `DANGER_TEXT`, and SHALL NOT contain rose. On the Board, rose
SHALL remain only in the Review column glyph and the priority.

#### Scenario: rose comes back on an error box
- **GIVEN** the element with `data-testid="task-action-error"`
- **WHEN** a rose class is put back anywhere in it
- **THEN** the wiring test fails

### Requirement: STATUS-VISUAL-01h — The hourglass has at most one meaning

The non-test sources under `client/src/components` SHALL contain `Hourglass` on at most
one line. Deferred work SHALL use `CalendarClock`, "others wait on this" `Link2`, a paused
agent `Pause`, "awaiting you" `STATUS_ICON.wait`, a review age `Clock`, and timed waits
`Timer`.

#### Scenario: an hourglass comes back
- **GIVEN** the component sources
- **WHEN** a second line naming `Hourglass` is added
- **THEN** the wiring test fails listing the lines

### Requirement: STATUS-VISUAL-01i — The three surfaces look the same in both themes

The Board, the plan view and the Agents pane SHALL match their reference screenshots in
light and dark, with seeded data that includes a `needs_input` task and an agent session
at work, so the amber chip and the sky blue are on screen.

#### Scenario: a status colour changes on screen
- **GIVEN** the seeded Board with a `needs_input` task and a working agent session
- **WHEN** the Board, the plan view or the Agents pane is captured in light or dark
- **THEN** the capture matches its reference screenshot

### Requirement: STATUS-VISUAL-01j — A card at work draws the square loader; a card state is a still glyph

The card surfaces (live effort chip, plan tile activity and plan card, session live row,
background work line, sub-agent card and strip, chat task card, agent rows of the sidebar
and of the Agents pane) SHALL draw an agent at work with `SparkLoader`, the one status
icon of Topics, in the box of the glyph it replaces. `StatusIcon` stays for the still
categories (backlog, todo, review, done, failed: red ring with a cross) and SHALL NOT
spin. Each `StatusIcon` carries `data-testid="status-glyph"` and `data-status`.

#### Scenario: a spinning half pie comes back on a card
- **GIVEN** one of the card surfaces
- **WHEN** it draws work in progress with a `live` or spinning `StatusIcon`
- **THEN** the unit test fails

### Requirement: STATUS-VISUAL-01k — The working loader plays what the agent is doing

Every surface that says an agent is working (chat tab and sidebar row, project
folder, terminal tab, the card surfaces of STATUS-VISUAL-01j that know their
task, the tray payload) SHALL know WHICH action the agent is doing, as one
`AgentAction` of `shared/agent-action.ts` (think, write, read, edit, run, web,
browse, delegate, tool, wait, error), and pass it to the loader. The action
SHALL become a loader shape through ONE map, `loaderActivityForAction` in
`loaderState.ts`, and it is final: think→think, write→write, read→search,
web→search, edit→write, run→tool, browse→tool, delegate→tool, tool→tool,
wait→wait, error→error. A loader whose surface knows no subject plays `think`.
The server SHALL classify each turn's stream frames once and send every window
a global `stream:action` frame (`topicId`, `sessionKey`, `action`) only when
that turn's action changes, because the finer stream frames reach only the
windows holding the chat; the client SHALL take a chat's action from
`stream:action` alone and clear it at `stream:end`. `stream:start` says nothing
about the action, so a hook phase keeps speaking until the first action. Tool names SHALL be classified by the one pure `classifyToolAction`,
MCP prefixes and provider spellings included. A shown action SHALL stay at
least 700 ms, the latest input winning when that time is up, and the store
SHALL change only when the shown action changes. A project folder SHALL show
`wait` when a child waits for the person, else the child that changed action
most recently.

#### Scenario: a turn runs three tools in a few milliseconds
- **GIVEN** a chat showing `read`
- **WHEN** an `edit` and a `run` arrive within 700 ms
- **THEN** the loader keeps `read` until 700 ms have passed, then shows `run`

#### Scenario: a reply streams text
- **GIVEN** a chat streaming its answer
- **WHEN** fifty content chunks arrive
- **THEN** the action store is written once

### Requirement: STATUS-VISUAL-01l — The tray plays the loader of the dominant action

The working glyph of the menu-bar strip SHALL be the square loader in the shape
of the dominant action the client sends with `set_app_status` (`think` when it
sends none), through the same map as STATUS-VISUAL-01k. Its frames SHALL come
from the engine itself: `scripts/gen-tray-loader-frames.ts` runs `LoaderBody`
at the size of the tray glyph and writes the squares of one natural cycle per
shape, at most 24 frames of 120 ms, into `tray_loader_frames.rs`, and a test
regenerates the file and fails when it differs. The waiting glyph SHALL be the
loader's `wait` shape at its reduced-motion still, in amber; review and stopped
keep their still glyphs. On macOS a frame step SHALL only swap the contents of
the overlay layer, never rebuild the strip image.

#### Scenario: an agent edits a file
- **GIVEN** an agent at work whose dominant action is `edit`
- **WHEN** the tray animation ticks
- **THEN** the overlay steps through the frames of the `write` shape and loops

#### Scenario: somebody tunes a loader shape
- **GIVEN** a change to a shape in `squareLoader.ts`
- **WHEN** the tray frames are not regenerated
- **THEN** the generator test fails
