## ADDED Requirements

### Requirement: E2E coverage for chat scroll behavior
The chat scroll system SHALL have Playwright E2E tests verifying auto-scroll, scroll anchoring, scroll-to-bottom button, and streaming behavior.

#### Scenario: Auto-scroll to bottom on new assistant message
- **GIVEN** the user is viewing the latest messages at the bottom of the chat
- **WHEN** a new assistant response arrives
- **THEN** the message list auto-scrolls to show the new content

#### Scenario: No auto-scroll when user has scrolled up
- **GIVEN** the user has scrolled up to read older messages
- **WHEN** a new assistant response arrives
- **THEN** the message list does NOT auto-scroll
- **AND** the user stays at their current scroll position

#### Scenario: Scroll-to-bottom button appears when scrolled up
- **GIVEN** the message list contains enough messages to scroll
- **WHEN** the user scrolls up away from the bottom
- **THEN** a scroll-to-bottom button appears as a floating action button

#### Scenario: Scroll-to-bottom button scrolls to latest message
- **GIVEN** the scroll-to-bottom button is visible
- **WHEN** the user clicks it
- **THEN** the message list scrolls to the latest message
- **AND** the scroll-to-bottom button disappears

#### Scenario: Streaming message keeps scroll at bottom
- **GIVEN** the user is at the bottom of the message list
- **WHEN** an assistant response is streaming (growing in real-time)
- **THEN** the message list stays scrolled to the bottom as content grows
