# TAB-BADGE: Tab Notification Badges

## TAB-BADGE-01: Badge appears on chat tab for new messages

**GIVEN** a pane group with multiple chat tabs open
**AND** Tab A is active, Tab B is inactive
**WHEN** a new assistant message arrives for the topic in Tab B
**THEN** Tab B shows a numeric badge "1"
**AND** subsequent messages increment the badge count

## TAB-BADGE-02: Badge clears on tab activation

**GIVEN** Tab B has a badge showing "3"
**WHEN** the user clicks Tab B to activate it
**THEN** the badge disappears immediately
**AND** the notification count resets to 0

## TAB-BADGE-03: Badge appears on agents pane when session completes

**GIVEN** an agents pane is open but not active
**AND** a Claude/agent session is running
**WHEN** the session status changes to "completed" or "error"
**THEN** the agents pane tab shows a badge with the count of newly completed/errored sessions

## TAB-BADGE-04: Badge appears on agents pane for approval requests

**GIVEN** an agents pane is open but not active
**WHEN** an approval request is created (WS: `approval:created`)
**THEN** the agents pane tab shows a badge incremented by 1

## TAB-BADGE-05: Badge coexists with streaming spinner

**GIVEN** a chat tab is streaming (spinner visible)
**AND** another event triggers a badge on the same tab
**WHEN** the user views the tab bar
**THEN** both the spinner AND the badge are visible simultaneously
**AND** neither obscures the other

## TAB-BADGE-06: Badge on terminal tab for error output

**GIVEN** a terminal pane is open but not active
**WHEN** the terminal receives error output (stderr or exit code != 0)
**THEN** the terminal tab shows a badge "!"
**AND** the badge clears when the terminal tab is activated

## TAB-BADGE-07: Badge does not appear on active tab

**GIVEN** a chat tab is currently active and focused
**WHEN** a new assistant message arrives for that tab's topic
**THEN** no badge appears (the user is already looking at it)

## TAB-BADGE-08: Multiple panes can have badges simultaneously

**GIVEN** three tabs: Chat A (active), Chat B (inactive), Agents (inactive)
**WHEN** Chat B receives a message AND an agent session completes
**THEN** both Chat B and Agents tabs show independent badge counts

## TAB-BADGE-09: Badge styling is consistent and non-intrusive

**GIVEN** any tab with a notification badge
**WHEN** the badge is rendered
**THEN** it displays as a small pill/circle with count
**AND** uses a distinct color (e.g., blue/primary) that contrasts with the tab background
**AND** does not cause layout shift or resize the tab
**AND** positions to the right of the tab title, before the close button

## TAB-BADGE-10: Topics with notifications float to top in sidebar

**GIVEN** the sidebar shows a list of topics
**AND** Topic X is lower in the list
**WHEN** Topic X receives a notification (new message, agent completed, etc.)
**THEN** Topic X moves to the top of the sidebar list (above non-notified topics)
**AND** the relative order among notified topics follows most-recent-notification-first
**AND** when the notification is cleared (topic opened), the topic returns to its original sort position

## TAB-BADGE-11: Sidebar notification reorder is animated

**GIVEN** the sidebar topic list is visible
**WHEN** a topic floats to the top due to a new notification
**THEN** the transition is smooth (not an abrupt jump)
**AND** no other sidebar items visually glitch during the reorder

## TAB-BADGE-12: Same topic in multiple panes shares badge state

**GIVEN** Topic X is open in both a standalone chat tab and a project window chat pane
**AND** neither pane is active
**WHEN** a new message arrives for Topic X
**THEN** both panes show the same badge count
**AND** activating either pane clears the badge on BOTH

## TAB-BADGE-13: Badge syncs across Electron windows

**GIVEN** Topic X is open in the main window AND in a detached window
**AND** the detached window has Topic X focused
**WHEN** a new message arrives for Topic X
**THEN** no badge appears on either window (user is looking at it in the detached window)

**GIVEN** Topic X is open in both windows but focused in neither
**WHEN** a new message arrives
**THEN** both windows show the badge
**AND** focusing Topic X in either window clears the badge in both

## TAB-BADGE-14: Badge state uses existing unread source of truth

**GIVEN** the sidebar already shows unread count for a topic via `unreadData`
**WHEN** a tab badge is rendered for the same topic
**THEN** the badge count matches the sidebar unread count (same data source)
**AND** there is no separate parallel counter

## TAB-BADGE-15: Badge survives WebSocket reconnection

**GIVEN** the app has accumulated badge counts on several tabs
**WHEN** the WebSocket connection drops and reconnects
**THEN** the server sends fresh `unread:init` with current counts
**AND** badge state is restored to match server state (not reset to 0)

## TAB-BADGE-16: Badge clears only for the focused topic on window refocus

**GIVEN** the app window lost focus (Cmd+Tab away)
**AND** messages arrived for Tab A and Tab B while away
**WHEN** the user returns to the app window
**THEN** only the currently active tab's badge clears
**AND** inactive tabs retain their badges
