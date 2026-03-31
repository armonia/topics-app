# Chat & Messaging

**Purpose:** Specifies behavioral scenarios for the chat messaging system including message lifecycle, rich content rendering, message actions, and input features.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic exists and is selected in the sidebar
- The chat panel is visible with the message input ready

## Requirements

### CHAT-01: Message Lifecycle

The system SHALL support sending messages, receiving streamed responses, loading conversation history, and aborting in-progress streams.

#### Scenario: Send message and receive streamed response
- GIVEN the message input is visible in an active topic
- WHEN the user types a message and presses Enter
- THEN the user message appears in the message list
- AND an assistant response streams in progressively

#### Scenario: Load message history on topic switch
- GIVEN two topics exist with different message histories
- WHEN the user switches from one topic to another
- THEN the new topic's message history loads in the message list

#### Scenario: Abort streaming via stop button
- GIVEN a message is being streamed with a streaming indicator visible
- WHEN the user clicks the stop button
- THEN streaming stops immediately
- AND the partial response text remains visible
- AND the message input becomes re-enabled

#### Scenario: Auto-scroll to bottom on new message
- GIVEN the user is viewing the latest messages at the bottom of the list
- WHEN a new assistant response arrives
- THEN the message list auto-scrolls to show the new content

#### Scenario: No auto-scroll when reading history
- GIVEN the user has scrolled up to read older messages
- WHEN a new assistant response arrives
- THEN the message list does NOT auto-scroll
- AND the user stays at their current scroll position

#### Scenario: Scroll-to-bottom button appears when scrolled up
- GIVEN the message list contains enough messages to scroll
- WHEN the user scrolls up away from the bottom
- THEN a scroll-to-bottom button appears
- AND clicking it scrolls to the latest message

#### Scenario: Multiline input with Shift+Enter
- GIVEN the message input is focused
- WHEN the user presses Shift+Enter
- THEN a new line is inserted in the input
- AND the message is NOT submitted

#### Scenario: Submit message via keyboard shortcut
- GIVEN the message input contains text
- WHEN the user presses Ctrl+Enter
- THEN the message is submitted

#### Scenario: Empty message submission is blocked
- GIVEN the message input is empty
- WHEN the user presses Enter
- THEN no message is sent
- AND the input remains focused

### CHAT-02: Rich Content Rendering

The system SHALL render rich content types within messages including markdown, code blocks, diffs, sub-agent cards, plan mode views, and tool call results.

#### Scenario: Markdown text renders with formatting
- GIVEN an assistant message contains markdown syntax including bold, inline code, and lists
- WHEN the message is displayed in the message list
- THEN bold text appears with strong emphasis
- AND inline code appears with distinct styling
- AND lists render as properly formatted items

#### Scenario: Code blocks render with syntax highlighting
- GIVEN an assistant message contains a fenced code block with a language identifier
- WHEN the message is displayed in the message list
- THEN the code block renders in a distinct container
- AND the code content preserves whitespace and formatting

#### Scenario: Diff block shows file changes with apply and reject actions
- GIVEN an assistant message contains a search-and-replace diff for a file
- WHEN the message is displayed in the message list
- THEN a diff block renders showing the file path
- AND an Apply button is visible to accept the change
- AND a Reject button is visible to discard the change

#### Scenario: Diff block apply action applies the change
- GIVEN a diff block is displayed with pending status
- WHEN the user clicks the Apply button
- THEN the file change is applied to the source file
- AND the diff block shows an applied status indicator

#### Scenario: Diff block reject action discards the change
- GIVEN a diff block is displayed with pending status
- WHEN the user clicks the Reject button
- THEN the change is discarded without modifying the file
- AND the diff block shows a rejected status indicator

#### Scenario: Sub-agent spawn card shows agent name and status
- GIVEN an assistant message contains a sub-agent spawn marker
- WHEN the message is displayed in the message list
- THEN a spawn card renders showing the agent task label
- AND the card displays the agent's current status
- AND token usage information is shown

#### Scenario: Plan mode displays steps with execute and reject options
- GIVEN an assistant message contains a numbered implementation plan
- WHEN the message is displayed in the message list
- THEN a plan view renders showing the individual steps
- AND an Execute Plan button is visible
- AND a Reject button is visible

#### Scenario: Tool call card shows tool name and execution status
- GIVEN an assistant message includes a tool call invocation
- WHEN the message is displayed in the message list
- THEN a tool call card renders showing the tool name
- AND the card shows the execution status (success or error)

#### Scenario: Tool call card expands to show arguments and result
- GIVEN a tool call card is displayed in a message
- WHEN the user clicks on the tool call card
- THEN the card expands to show the tool arguments
- AND the tool result or output is displayed

#### Scenario: Tool call error renders with error styling
- GIVEN a tool call completed with an error
- WHEN the tool call card is displayed in the message list
- THEN the card shows an error status indicator
- AND expanding the card reveals the error message

#### Scenario: Image attachment renders as inline thumbnail
- GIVEN an assistant message includes an image attachment
- WHEN the message is displayed in the message list
- THEN the image renders as a visible thumbnail

#### Scenario: Image attachment opens lightbox on click
- GIVEN an image thumbnail is displayed in a message
- WHEN the user clicks on the image
- THEN a lightbox overlay opens showing the full-size image
- AND a close button is available to dismiss the lightbox

#### Scenario: File attachment renders as download link
- GIVEN an assistant message includes a non-image file attachment
- WHEN the message is displayed in the message list
- THEN a file attachment element renders showing the filename
- AND the element links to the file for download
