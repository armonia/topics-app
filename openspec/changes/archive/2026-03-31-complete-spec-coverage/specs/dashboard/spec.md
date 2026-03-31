## ADDED Requirements

### Requirement: DASH-02 — Activity Feed

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
