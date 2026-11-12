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
