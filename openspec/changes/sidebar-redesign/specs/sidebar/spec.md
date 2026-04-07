# Sidebar Redesign — Acceptance Criteria

## AC-1: Timeline View (Default)

**GIVEN** the sidebar is in timeline view (default)
**WHEN** the user looks at the sidebar
**THEN** all active items (projects, chats, terminals, browsers) appear in a single flat list ordered by most recent activity (message received, terminal output, browser navigation, project file change)

**GIVEN** a project item in the timeline
**WHEN** the user clicks to expand it
**THEN** an accordion opens showing the project's active resources: chat topics, running terminals, open browsers — each as a sub-item

**GIVEN** a chat receives a new message
**WHEN** the sidebar updates
**THEN** that chat (or its parent project if it belongs to one) moves to the top of the timeline

## AC-2: Grouped View

**GIVEN** the user clicks the view toggle button next to the search bar
**WHEN** the view switches to "grouped by type"
**THEN** items are organized into sections: Projects, Chat, Terminals, Browser — each section sorted internally by recency

**GIVEN** the user is in grouped view
**WHEN** they click the toggle again
**THEN** the view returns to timeline mode

## AC-3: Archive Toggle

**GIVEN** the sidebar shows only active items by default
**WHEN** the user activates the archive toggle (near the search bar)
**THEN** archived/closed items appear in the list with a visual distinction (dimmed, badge, or separator)

**GIVEN** the archive toggle is active
**WHEN** the user deactivates it
**THEN** archived items disappear from the list

## AC-4: Project Accordion Content

**GIVEN** a project is expanded in the sidebar
**WHEN** the project has 2 active chats, 1 running terminal, and 1 open browser
**THEN** all 4 resources are listed under the project accordion, each with its type icon

**GIVEN** a project has no active resources
**WHEN** the archive toggle is OFF
**THEN** the project does NOT appear in the timeline (nothing active to show)

**GIVEN** the archive toggle is ON
**WHEN** a project has only archived chats
**THEN** the project appears with its archived resources shown dimmed

## AC-5: Activity Sorting

**GIVEN** multiple items in the timeline
**WHEN** a terminal produces new output
**THEN** that terminal (or its parent project) moves to the top

**GIVEN** items with unread notifications
**WHEN** the sidebar renders
**THEN** items with unread counts show their badge, and unread items sort above read items of the same timestamp

## AC-6: Search Integration

**GIVEN** the user types in the search bar
**WHEN** results filter
**THEN** the current view mode is preserved (timeline or grouped) and only matching items show

**GIVEN** a search term matches a resource inside a project
**WHEN** filtering
**THEN** the project appears expanded with only matching resources visible

## AC-7: Type Indicators

**GIVEN** the timeline view mixes different resource types
**WHEN** items render
**THEN** each item shows a small type icon/indicator (chat bubble, terminal prompt, globe, folder) so the user can distinguish types at a glance

## AC-8: Toggle Controls Layout

**GIVEN** the sidebar header area
**WHEN** rendered
**THEN** the search bar is followed by two small toggle buttons: view mode (timeline/grouped) and archive visibility — compact, not taking extra vertical space
