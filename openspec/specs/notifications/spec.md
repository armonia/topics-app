## Purpose

Specifies behavioral scenarios for the unified attention system: the numeric badge that
one topic shows on every surface at once (pane tab, sidebar row, OS app badge), the
per-topic mute that silences the interruption without hiding the count, and the parity
contract that keeps those surfaces from drifting apart.

## Background

Common preconditions shared across scenarios:

- The user is logged into Topics App and the sidebar is visible
- Attention reaches the client as WebSocket frames: `unread:updated` for chat messages,
  `session:state` for a Claude Code phase transition
- A badge count is read from a single rollup (`getBadgeCount` in
  `client/src/hooks/useTabNotifications.tsx`), never from a per-surface counter

## Requirements

### Requirement: TAB-BADGE-01 — Unread badge on an inactive chat tab

The system SHALL render the topic's unread count as a numeric badge on that topic's pane
tab while the tab is not the active one.

#### Scenario: Unread count paints a badge on the inactive tab
- **GIVEN** two topics A and B are open as pane tabs and B is the active tab
- **WHEN** the server broadcasts `unread:updated` for topic A with a count of 3
- **THEN** A's pane tab shows a badge whose text is exactly "3"

### Requirement: TAB-BADGE-02 — Badge clears when the tab is activated

The system SHALL remove the badge from a tab once the topic's unread count returns to
zero after the user activates that tab.

> Written from the test: the E2E injects the `unread:updated → 0` frame itself after the
> click, so what is pinned is the client's rendering of a zeroed count, not the server's
> decision to clear unread on focus.

#### Scenario: Activating the tab drops the badge
- **GIVEN** topic A's inactive pane tab shows a badge of "5"
- **WHEN** the user clicks A's tab to activate it
- **AND** the server reports A's unread count as 0
- **THEN** the badge is no longer visible on A's tab

### Requirement: TAB-BADGE-07 — No badge on the active tab

The system SHALL suppress the unread badge on the tab the user is already looking at:
`getBadgeCount` returns 0 for an active pane regardless of the unread count the server
reports for its topic.

> Written from the test, which is tagged `@nightly` and runs off the PR gate: its
> negative assertion (wait, then expect count 0) is timing-sensitive on CI-Linux.

#### Scenario: Unread on the active topic paints nothing
- **GIVEN** topic A is open as the single, active pane tab
- **WHEN** the server broadcasts `unread:updated` for topic A with a count of 2
- **THEN** no badge element is rendered inside A's tab

### Requirement: TAB-BADGE-08 — Badges are independent per pane

The system SHALL track badge state per pane, so a badge raised on one tab neither
appears on nor clears another tab's badge.

#### Scenario: Switching the active tab moves which tab can carry a badge
- **GIVEN** topics A and B are open as pane tabs and B is active
- **WHEN** the server broadcasts an unread count of 2 for A
- **THEN** A's tab shows a badge of "2"
- **WHEN** the user activates A, A's unread is reported as 0, and B is reported unread 7
- **THEN** B's tab shows a badge of "7"
- **AND** A's tab shows no badge, because A is now the active tab

### Requirement: TAB-BADGE-09 — Badge is a filled pill that does not resize the tab

The system SHALL render the badge with a non-transparent background, and adding a badge
SHALL NOT change the width of the tab it sits on.

> Written from the test, and no wider: it pins a computed `background-color` that is not
> transparent and a tab width that stays exactly 150px with a two-digit count. Shape,
> colour token and position relative to the close button are not asserted.

#### Scenario: A two-digit badge keeps the tab at its fixed width
- **GIVEN** topics A and B are open as pane tabs and B is active
- **WHEN** the server broadcasts an unread count of 42 for topic A
- **THEN** A's tab shows a badge whose text is exactly "42"
- **AND** the badge's computed background colour is neither `transparent` nor fully transparent rgba
- **AND** A's tab is 150px wide

### Requirement: MUTE-01 — Mute silences the interruption, never the count

The system SHALL suppress the native completion banner (and its sound) for a topic whose
`muted` flag is set, while still counting that topic's attention in the app badge and in
its own on-screen tab badge. The mute gate (`client/src/lib/notify/muteGate.ts`) decides
only the interruption; the badge rides the attention rollup, which never consults it.

#### Scenario: Two sessions finish, one muted — exactly one banner fires
- **GIVEN** a muted topic and an unmuted topic are both open, and neither is the focused pane
- **AND** both have been seen in the `running` phase (the first frame for a session only records the phase)
- **WHEN** both flip from `running` to `completed` in the same tick
- **THEN** exactly one native notification is constructed
- **AND** its title names the unmuted topic and never the muted one

#### Scenario: The app badge counts the muted topic too
- **GIVEN** both topics have just completed as above
- **WHEN** each topic is reported with an unread count of 1
- **THEN** `navigator.setAppBadge` is called with the previous total plus 2
- **AND** the muted topic's own pane tab shows a badge of "1"

#### Scenario: Foregrounding the muted topic drops its share of the badge
- **GIVEN** the app badge counts both topics
- **WHEN** the user activates the muted topic's pane and its unread is reported as 0
- **THEN** the app badge falls back by exactly one, keeping the still-backgrounded topic's share

### Requirement: PARITY-01 — Same count on the tab bar and the sidebar row

The system SHALL show the same unread count for a topic on its pane tab and on its
sidebar row, and SHALL NOT render the retired per-Claude phase dot on any surface — the
phase signal is folded into the badge.

#### Scenario: One unread event paints both surfaces with the same number
- **GIVEN** topics A and B are open as pane tabs and B is active, leaving A unfocused on both surfaces
- **WHEN** the server broadcasts an unread count of 2 for topic A
- **THEN** A's pane tab shows a badge of "2"
- **AND** A's sidebar row shows a badge of "2"

#### Scenario: No legacy phase dot survives anywhere
- **GIVEN** the app is rendered with the badge above in place
- **WHEN** the page is searched for the retired `ClaudePhaseDot` tooltips ("Awaiting your approval", "Claude is generating…", "Claude is running a tool", "Claude replied — waiting for you", "Approval timed out — still waiting on you", "Session error", "Finished a turn — click to open")
- **THEN** none of them is present
