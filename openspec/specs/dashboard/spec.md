# Dashboard & Analytics

**Purpose:** Specifies behavioral scenarios for the analytics dashboard including KPI cards, time-series charts, agent leaderboard, activity feed via SSE, daily journal, and real-time data refresh.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The dashboard view is accessible from the sidebar navigation
- Historical data exists for KPI calculations and chart rendering

## Requirements

### DASH-01: KPIs, Charts, Leaderboard, Activity Feed & Journal

The system SHALL display KPI metric cards, interactive time-series charts with range selection, an agent leaderboard table, a live activity feed via SSE, a daily journal with date navigation, and support real-time data refresh via WebSocket notifications.

#### Scenario: KPI cards render with numeric data values
- GIVEN the dashboard view is open
- WHEN the KPI section loads
- THEN KPI cards are displayed in a grid layout
- AND each card shows a non-empty numeric value

#### Scenario: KPI cards show labels describing each metric
- GIVEN the dashboard view is open
- WHEN the KPI cards are visible
- THEN each card displays a descriptive label for its metric
- AND the labels identify metrics such as throughput, cycle time, and error rate

#### Scenario: KPI grid adjusts layout for different screen sizes
- GIVEN the dashboard is displayed at desktop viewport width
- WHEN the viewport is resized to mobile width
- THEN all KPI cards remain visible
- AND the cards reflow to fit the narrower screen

#### Scenario: Time-series chart renders with data points
- GIVEN the dashboard view is open with historical data available
- WHEN the chart section loads
- THEN a time-series chart renders as a visual graphic
- AND data points are plotted along the time axis

#### Scenario: Chart displays axis labels
- GIVEN the time-series chart is visible
- WHEN the chart is fully rendered
- THEN axis labels are displayed along the chart edges
- AND the labels indicate time periods and metric values

#### Scenario: Default chart range shows seven days of data
- GIVEN the dashboard view is freshly opened
- WHEN the time-series chart renders
- THEN the chart displays seven data points corresponding to the last seven days

#### Scenario: Range selector buttons allow switching time periods
- GIVEN the time-series chart is visible
- WHEN the user views the range selector
- THEN buttons for different time periods are available including day, week, and month options

#### Scenario: Selecting a different range updates the chart data
- GIVEN the chart is showing the default seven-day range
- WHEN the user clicks the thirty-day range button
- THEN the chart updates to display thirty data points
- AND the chart line path changes to reflect the new data range

#### Scenario: Agent leaderboard table renders with agent rows
- GIVEN the dashboard view is open
- WHEN the leaderboard section loads
- THEN a table is displayed with column headers
- AND data rows appear with agent information

#### Scenario: Leaderboard shows agent name and performance metrics
- GIVEN the leaderboard table is visible
- WHEN the user examines the table columns
- THEN each row displays an agent name
- AND columns include tasks done, tokens used, average cycle time, error rate, and sessions

#### Scenario: Leaderboard displays column headers for sorting context
- GIVEN the leaderboard table is visible
- WHEN the user views the header row
- THEN headers include rank, agent name, tasks done, tokens, average cycle time, error rate, and sessions

> Note: Leaderboard column sorting by clicking headers is not currently tested. Sorting may or may not be implemented.

#### Scenario: Activity feed shows live events via SSE connection
- GIVEN the activity feed panel is open
- WHEN SSE events arrive from the server
- THEN each event appears in the activity feed
- AND the feed displays event descriptions

#### Scenario: Activity feed updates in real-time as new events arrive
- GIVEN the activity feed is open and displaying events
- WHEN a new SSE event is received from the server
- THEN the new event appears in the feed without requiring a page refresh

#### Scenario: Activity feed shows event details
- GIVEN events are displayed in the activity feed
- WHEN the user views an event entry
- THEN the event shows a descriptive title summarizing the activity

#### Scenario: Activity feed displays live tab by default
- GIVEN the user opens the activity feed panel
- WHEN the panel renders
- THEN the Live tab is selected and visible
- AND live events are shown in the feed content area

#### Scenario: Activity feed empty state shows placeholder
- GIVEN the activity feed panel is open
- WHEN no events have been received
- THEN a placeholder message is displayed indicating no activity yet

#### Scenario: Dashboard refetches data on WebSocket update notification
- GIVEN the dashboard is open and displaying KPI data
- WHEN a dashboard update notification arrives via WebSocket
- THEN the dashboard refetches KPI data from the server
- AND the displayed values reflect the latest data

#### Scenario: Auto-refresh label shows the refresh interval
- GIVEN the dashboard view is open
- WHEN the dashboard header area is visible
- THEN an auto-refresh label is displayed showing a sixty-second interval

#### Scenario: Dashboard handles loading state
- GIVEN the user navigates to the dashboard
- WHEN data is being fetched from the server
- THEN a loading indicator is displayed
- AND the indicator disappears once data has loaded

> Note: Loading state behavior has limited test coverage. The exact visual indicator (skeleton, spinner) may vary.

#### Scenario: Journal pane loads with current date
- GIVEN the user opens the activity feed and switches to the Digest tab
- WHEN the journal panel loads
- THEN the current date is displayed in the date navigation area
- AND journal content for the current date is shown

#### Scenario: Journal date navigation allows moving between days
- GIVEN the journal panel is open with the current date displayed
- WHEN the user clicks the previous day navigation button
- THEN the displayed date changes to the previous day
- AND journal content updates to show entries for that day

#### Scenario: Journal digest displays summary text
- GIVEN the journal panel is open on the Digest tab
- WHEN digest content exists for the selected date
- THEN a digest summary text is displayed in the journal area

#### Scenario: Journal events tab shows individual event entries
- GIVEN the journal panel is open
- WHEN the user clicks the Events tab
- THEN individual event entries are listed with their summaries

#### Scenario: Journal entries display with descriptive summaries
- GIVEN the journal Events tab is selected
- WHEN events exist for the selected date
- THEN each entry shows a descriptive summary of the activity

> Note: Journal entry creation (adding new entries manually) has no test coverage. Current journal is read-only displaying server-generated events and digests.

#### Scenario: Dashboard navigation from sidebar
- GIVEN the user is on any view in the application
- WHEN the user clicks the Settings button in the sidebar and selects Statistics
- THEN the dashboard view opens with KPI cards and chart visible

#### Scenario: Chart area fill and line paths render distinctly
- GIVEN the time-series chart is visible
- WHEN the chart renders with data
- THEN both an area fill path and a line path are rendered
- AND the two paths have distinct visual representations
