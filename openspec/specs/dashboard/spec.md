## Purpose

Specifies behavioral scenarios for the analytics dashboard including KPI cards, time-series charts, agent leaderboard, activity feed via SSE, daily journal, and real-time data refresh.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The dashboard view is accessible from the sidebar navigation
- Historical data exists for KPI calculations and chart rendering
## Requirements
### Requirement: DASH-01 — KPIs, Charts, Leaderboard, Activity Feed & Journal

The system SHALL display KPI metric cards, interactive time-series charts with range selection, an agent leaderboard table, a live activity feed via SSE, a daily journal with date navigation, and support real-time data refresh via WebSocket notifications.

#### Scenario: KPI cards render with numeric data values
- **GIVEN** the dashboard view is open
- **WHEN** the KPI section loads
- **THEN** KPI cards are displayed in a grid layout
- **AND** each card shows a non-empty numeric value

#### Scenario: KPI cards show labels describing each metric
- **GIVEN** the dashboard view is open
- **WHEN** the KPI cards are visible
- **THEN** each card displays a descriptive label for its metric
- **AND** the labels identify metrics such as throughput, cycle time, and error rate

#### Scenario: KPI grid adjusts layout for different screen sizes
- **GIVEN** the dashboard is displayed at desktop viewport width
- **WHEN** the viewport is resized to mobile width
- **THEN** all KPI cards remain visible
- **AND** the cards reflow to fit the narrower screen

#### Scenario: Time-series chart renders with data points
- **GIVEN** the dashboard view is open with historical data available
- **WHEN** the chart section loads
- **THEN** a time-series chart renders as a visual graphic
- **AND** data points are plotted along the time axis

#### Scenario: Chart displays axis labels
- **GIVEN** the time-series chart is visible
- **WHEN** the chart is fully rendered
- **THEN** axis labels are displayed along the chart edges
- **AND** the labels indicate time periods and metric values

#### Scenario: Default chart range shows seven days of data
- **GIVEN** the dashboard view is freshly opened
- **WHEN** the time-series chart renders
- **THEN** the chart displays seven data points corresponding to the last seven days

#### Scenario: Range selector buttons allow switching time periods
- **GIVEN** the time-series chart is visible
- **WHEN** the user views the range selector
- **THEN** buttons for different time periods are available including day, week, and month options

#### Scenario: Selecting a different range updates the chart data
- **GIVEN** the chart is showing the default seven-day range
- **WHEN** the user clicks the thirty-day range button
- **THEN** the chart updates to display thirty data points
- **AND** the chart line path changes to reflect the new data range

#### Scenario: Agent leaderboard table renders with agent rows
- **GIVEN** the dashboard view is open
- **WHEN** the leaderboard section loads
- **THEN** a table is displayed with column headers
- **AND** data rows appear with agent information

#### Scenario: Leaderboard shows agent name and performance metrics
- **GIVEN** the leaderboard table is visible
- **WHEN** the user examines the table columns
- **THEN** each row displays an agent name
- **AND** columns include tasks done, tokens used, average cycle time, error rate, and sessions

#### Scenario: Leaderboard displays column headers for sorting context
- **GIVEN** the leaderboard table is visible
- **WHEN** the user views the header row
- **THEN** headers include rank, agent name, tasks done, tokens, average cycle time, error rate, and sessions

> Note: Leaderboard column sorting by clicking headers is not currently tested. Sorting may or may not be implemented.

#### Scenario: Activity feed shows live events via SSE connection
- **GIVEN** the activity feed panel is open
- **WHEN** SSE events arrive from the server
- **THEN** each event appears in the activity feed
- **AND** the feed displays event descriptions

#### Scenario: Activity feed updates in real-time as new events arrive
- **GIVEN** the activity feed is open and displaying events
- **WHEN** a new SSE event is received from the server
- **THEN** the new event appears in the feed without requiring a page refresh

#### Scenario: Activity feed shows event details
- **GIVEN** events are displayed in the activity feed
- **WHEN** the user views an event entry
- **THEN** the event shows a descriptive title summarizing the activity

#### Scenario: Activity feed displays live tab by default
- **GIVEN** the user opens the activity feed panel
- **WHEN** the panel renders
- **THEN** the Live tab is selected and visible
- **AND** live events are shown in the feed content area

#### Scenario: Activity feed empty state shows placeholder
- **GIVEN** the activity feed panel is open
- **WHEN** no events have been received
- **THEN** a placeholder message is displayed indicating no activity yet

#### Scenario: Dashboard refetches data on WebSocket update notification
- **GIVEN** the dashboard is open and displaying KPI data
- **WHEN** a dashboard update notification arrives via WebSocket
- **THEN** the dashboard refetches KPI data from the server
- **AND** the displayed values reflect the latest data

#### Scenario: Auto-refresh label shows the refresh interval
- **GIVEN** the dashboard view is open
- **WHEN** the dashboard header area is visible
- **THEN** an auto-refresh label is displayed showing a sixty-second interval

#### Scenario: Dashboard handles loading state
- **GIVEN** the user navigates to the dashboard
- **WHEN** data is being fetched from the server
- **THEN** a loading indicator is displayed
- **AND** the indicator disappears once data has loaded

> Note: Loading state behavior has limited test coverage. The exact visual indicator (skeleton, spinner) may vary.

#### Scenario: Journal pane loads with current date
- **GIVEN** the user opens the activity feed and switches to the Digest tab
- **WHEN** the journal panel loads
- **THEN** the current date is displayed in the date navigation area
- **AND** journal content for the current date is shown

#### Scenario: Journal date navigation allows moving between days
- **GIVEN** the journal panel is open with the current date displayed
- **WHEN** the user clicks the previous day navigation button
- **THEN** the displayed date changes to the previous day
- **AND** journal content updates to show entries for that day

#### Scenario: Journal digest displays summary text
- **GIVEN** the journal panel is open on the Digest tab
- **WHEN** digest content exists for the selected date
- **THEN** a digest summary text is displayed in the journal area

#### Scenario: Journal events tab shows individual event entries
- **GIVEN** the journal panel is open
- **WHEN** the user clicks the Events tab
- **THEN** individual event entries are listed with their summaries

#### Scenario: Journal entries display with descriptive summaries
- **GIVEN** the journal Events tab is selected
- **WHEN** events exist for the selected date
- **THEN** each entry shows a descriptive summary of the activity

> Note: Journal entry creation (adding new entries manually) has no test coverage. Current journal is read-only displaying server-generated events and digests.

#### Scenario: Dashboard navigation from sidebar
- **GIVEN** the user is on any view in the application
- **WHEN** the user clicks the Settings button in the sidebar and selects Statistics
- **THEN** the dashboard view opens with KPI cards and chart visible

#### Scenario: Chart area fill and line paths render distinctly
- **GIVEN** the time-series chart is visible
- **WHEN** the chart renders with data
- **THEN** both an area fill path and a line path are rendered
- **AND** the two paths have distinct visual representations

### Requirement: DASH-02 — Activity Feed

**Status: NOT BUILT** — No activity feed exists in any form: no `ActivityFeed` or `JournalPanel` in the client, and `server/routes/activity.ts` exposes `GET /api/activity/log` and nothing else. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL display a real-time activity feed powered by SSE with Live and Digest tabs, event filtering by category, text search with debounce, pause/resume controls, virtualized scrolling, and connection status indication.

#### Scenario: Live tab is selected by default on feed open
- **GIVEN** the activity feed panel renders
- **WHEN** no tab has been manually selected
- **THEN** the "Live" tab is visually active with primary styling
- **AND** the live event list is displayed in the content area

#### Scenario: Switching to Digest tab shows journal panel
- **GIVEN** the activity feed panel is open on the Live tab
- **WHEN** the user clicks the "Digest" tab
- **THEN** the Digest tab becomes active with primary styling
- **AND** the JournalPanel component loads inside the content area
- **AND** the live event list is no longer visible

#### Scenario: Pause button stops feed updates
- **GIVEN** the activity feed is open on the Live tab and receiving events
- **WHEN** the user clicks the Pause button in the toolbar
- **THEN** the button changes to a Play icon with yellow styling
- **AND** a "paused" label appears in the toolbar
- **AND** new incoming SSE events do not appear in the feed

#### Scenario: Resume button restarts feed updates
- **GIVEN** the activity feed is paused with the Play icon visible
- **WHEN** the user clicks the Play button
- **THEN** the button returns to a Pause icon
- **AND** the "paused" label disappears
- **AND** new SSE events resume appearing in the feed

#### Scenario: Search bar filters events by text
- **GIVEN** the activity feed has multiple events displayed
- **WHEN** the user clicks the Search button and types a query
- **THEN** only events whose title matches the search text are shown
- **AND** the filter applies after a 200ms debounce delay

#### Scenario: Clearing search input restores all events
- **GIVEN** the search bar is visible with a filter query entered
- **WHEN** the user clicks the X clear button on the search input
- **THEN** the search input clears to empty
- **AND** all events are displayed again without filtering

#### Scenario: Category filter toggles narrow visible events
- **GIVEN** the filter panel is open showing category buttons
- **WHEN** the user clicks a category button such as "exec"
- **THEN** only events of that category are visible
- **AND** the filter button shows the active filter count

#### Scenario: Empty state shows placeholder when no events exist
- **GIVEN** the activity feed is open and connected
- **WHEN** no SSE events have been received
- **THEN** a "No activity yet" placeholder message is displayed in the feed area

#### Scenario: Disconnected state shows connecting message
- **GIVEN** the SSE connection has not been established
- **WHEN** the activity feed renders with no events
- **THEN** a "Connecting to activity stream..." message is displayed
- **AND** a "disconnected" label appears in the toolbar

#### Scenario: Jump to bottom button appears when scrolled up
- **GIVEN** the activity feed has many events and the user has scrolled up
- **WHEN** new events arrive
- **THEN** a "Latest" button with a down arrow appears at the bottom-right
- **AND** clicking the button scrolls the feed to the most recent event

#### Scenario: Auto-scroll follows new events at bottom
- **GIVEN** the user is viewing the latest events at the bottom of the feed
- **WHEN** a new SSE event arrives
- **THEN** the feed automatically scrolls to show the new event

#### Scenario: Event item displays relative timestamp, icon, and title
- **GIVEN** events are displayed in the activity feed
- **WHEN** the user views an event row
- **THEN** a relative timestamp is shown on the left (e.g., "3s", "5m")
- **AND** a category-colored icon is displayed
- **AND** the event title text is shown

#### Scenario: Expanding an event item shows detail content
- **GIVEN** an event with detail or raw data exists in the feed
- **WHEN** the user clicks on the event row
- **THEN** a detail section expands below the event showing the detail text in a monospace font
- **AND** clicking again collapses the detail section

### Requirement: DASH-03 — Journal & Digest

**Status: NOT BUILT** — No `/api/journal`, no `/api/digest`, no journal panel. `server/lib/tab-resolver.test.ts:363` asserts the opposite of this requirement: that `journal` is NOT an emittable pane. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL provide a journal panel with date navigation, a Journal tab showing AI-generated digest summaries, an Events tab listing individual activity entries, and controls for generating new digest entries.

#### Scenario: Journal panel displays current date on load
- **GIVEN** the journal panel opens inside the Digest tab
- **WHEN** the panel finishes loading
- **THEN** the current date is displayed in the date navigation bar formatted as weekday, month, and day
- **AND** a "(today)" indicator appears next to the date

#### Scenario: Previous day button navigates to earlier date
- **GIVEN** the journal panel is showing the current date
- **WHEN** the user clicks the left chevron (previous day) button
- **THEN** the displayed date changes to the previous calendar day
- **AND** journal content updates to reflect the selected date

#### Scenario: Next day button is disabled on today
- **GIVEN** the journal panel is showing today's date
- **WHEN** the user views the next day button
- **THEN** the right chevron button is visually disabled with reduced opacity
- **AND** clicking it has no effect

#### Scenario: Next day button navigates forward from a past date
- **GIVEN** the journal panel is showing a past date
- **WHEN** the user clicks the right chevron (next day) button
- **THEN** the displayed date advances by one day
- **AND** journal content updates accordingly

#### Scenario: Go to today button returns to current date
- **GIVEN** the journal panel is displaying a past date
- **WHEN** the user clicks the date text in the navigation bar
- **THEN** the panel returns to today's date
- **AND** the "(today)" indicator reappears

#### Scenario: Journal tab shows digest summary text
- **GIVEN** the journal panel is on the Journal tab
- **WHEN** a digest exists for the selected date
- **THEN** the digest summary text is displayed in a prose-formatted area

#### Scenario: Journal tab shows generate button when no digest exists
- **GIVEN** the journal panel is on the Journal tab
- **WHEN** no digest exists for the selected date but events are available
- **THEN** a "No journal entry for this day yet." message is displayed
- **AND** a "Generate Journal Entry" button with a sparkle icon is visible

#### Scenario: Generate digest button triggers digest creation
- **GIVEN** the "Generate Journal Entry" button is visible
- **WHEN** the user clicks the button
- **THEN** the button changes to show "Generating..." with a spinning icon
- **AND** the button becomes disabled during generation

#### Scenario: Events tab lists individual event entries
- **GIVEN** the journal panel is open
- **WHEN** the user clicks the "Events" tab
- **THEN** individual event rows are listed with icon, summary text, and timestamp
- **AND** the tab label shows the event count in parentheses

#### Scenario: Events tab empty state for day with no activity
- **GIVEN** the journal panel Events tab is selected
- **WHEN** no events exist for the selected date
- **THEN** a "No events recorded for this day." message is displayed

#### Scenario: Refresh button reloads journal data
- **GIVEN** the journal panel is open
- **WHEN** the user clicks the refresh button in the date navigation bar
- **THEN** the journal data reloads from the server
- **AND** the refresh icon spins during loading

