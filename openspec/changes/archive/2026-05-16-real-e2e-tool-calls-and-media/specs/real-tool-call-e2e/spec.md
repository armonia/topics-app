## ADDED Requirements

### Requirement: REAL-TC-01 — History messages with tool calls render ToolCallBadge components

The system SHALL render ToolCallBadge components for messages that have `toolCalls` data stored in the database, when those messages are loaded from chat history.

#### Scenario: Seeded message with tool call renders badge with tool name
- **WHEN** a message with `toolCalls: [{ id: "tc-seed-1", name: "Read", args: { path: "/test.ts" }, status: "success", result: "content", contentOffset: 0 }]` exists in the database
- **AND** the user navigates to the topic containing that message
- **THEN** a `[data-testid="tool-call-tc-seed-1"]` element SHALL be visible in the DOM
- **AND** it SHALL contain text "Read"

#### Scenario: Tool call badge expands to show args and result
- **WHEN** a rendered tool call badge is clicked
- **THEN** a `[data-testid="tool-call-args"]` element SHALL be visible containing the tool arguments
- **AND** a `[data-testid="tool-call-result"]` element SHALL be visible containing the tool result

#### Scenario: Error tool call renders with error status
- **WHEN** a message with a tool call having `status: "error"` and `error: "Permission denied"` is loaded
- **THEN** the badge SHALL have `[data-testid="tool-call-status"][data-status="error"]`
- **AND** expanding it SHALL show `[data-testid="tool-call-error"]` containing "Permission denied"

#### Scenario: Multiple tool calls render in correct order
- **WHEN** a message with 3 tool calls (contentOffset 0, 50, 120) is loaded
- **THEN** 3 tool call badges SHALL be visible
- **AND** they SHALL appear in document order matching their contentOffset order

### Requirement: REAL-TC-02 — History messages with media render MediaImage and MediaFile components

The system SHALL render media attachment components for messages that have `media` paths stored in the database.

#### Scenario: Message with image media renders MediaImage
- **WHEN** a message with `media: ["/uploads/test-screenshot.png"]` exists in the database
- **AND** the image file is accessible (mocked via context.route for /uploads/)
- **THEN** a `[data-testid="media-image"]` element SHALL be visible
- **AND** its `src` attribute SHALL contain the media path

#### Scenario: Message with file media renders MediaFile
- **WHEN** a message with `media: ["/uploads/test-report.pdf"]` exists in the database
- **THEN** a `[data-testid="media-file"]` element SHALL be visible
- **AND** a `[data-testid="media-file-name"]` element SHALL contain "test-report.pdf"

### Requirement: REAL-TC-03 — Live chat streaming produces visible tool call badges

The system SHALL render tool call badges in real-time when an AI response includes tool use during a live chat session, with the full pipeline (server SSE/WS → client state → DOM) operating without mocks.

#### Scenario: Live chat message triggers tool call that appears in UI
- **GIVEN** the gateway/AI service is available
- **WHEN** a user sends a message that triggers tool use (e.g., "Read package.json")
- **THEN** within 30 seconds, at least one `[data-testid^="tool-call-"]` element SHALL appear in the message area
- **AND** the tool call badge SHALL have a `[data-testid="tool-call-name"]` with a non-empty text

#### Scenario: Test skips gracefully when gateway is unavailable
- **GIVEN** the gateway/AI service is NOT available
- **WHEN** the live tool call test attempts to run
- **THEN** the test SHALL skip with annotation "Gateway unavailable"
- **AND** no test failure SHALL be reported
