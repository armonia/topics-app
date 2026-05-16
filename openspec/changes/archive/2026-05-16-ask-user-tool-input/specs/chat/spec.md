# Delta — chat capability

## ADDED Requirements

### Requirement: Tool calls can request structured user input

When the active provider emits a tool call whose semantics require a human answer (e.g. the Claude Agent SDK's `AskUserQuestion`, an MCP server's `elicitation/create`), the system SHALL detect the request, suspend the per-stream inactivity timer for that turn, expose a `"waiting_for_input"` status on the tool call, and propagate a `UserInputRequiredEvent` to the client.

The system SHALL NOT silently drop user-input-requiring tool calls: when the provider declares no `resumeWithToolResponse` capability, the tool SHALL transition to `status: "error"` with a human-readable message instead of hanging in `running`.

The system SHALL accept the user's submitted response on `POST /api/chat/tool-response`, persist it onto the corresponding `tool_calls[].userResponse` blob, re-inject it into the provider's input stream, and broadcast the resulting status transition over the WebSocket.

The system SHALL preserve `waiting_for_input` state across a single client refresh: if the user reloads the page while a tool is awaiting input, `GET /api/topics/:id/history` (or its WebSocket equivalent) SHALL return the tool call with `status: "waiting_for_input"` and `userInputSchema` populated, so the form can be re-rendered.

#### Scenario: AskUserQuestion shows a form instead of a spinner

- **GIVEN** an active topic backed by the `claude-code` provider
- **AND** the model emits a `tool_use` block with `name === "AskUserQuestion"` and a valid `input.questions` array
- **WHEN** the stream event reaches the route handler
- **THEN** the matching tool call's status SHALL be `"waiting_for_input"`
- **AND** a `UserInputRequiredEvent` SHALL be broadcast to clients focused on the topic
- **AND** the client SHALL render a form (radio options for each question) inside the tool call row
- **AND** the stream's soft inactivity timer SHALL remain suspended while the form is open

#### Scenario: Submitting the form resumes the turn

- **GIVEN** a tool call is in `"waiting_for_input"` with a `questions` schema
- **WHEN** the user selects an answer for each question and clicks Send
- **THEN** the client SHALL `POST /api/chat/tool-response` with `{ sessionKey, toolCallId, response }`
- **AND** the server SHALL persist the response onto the message's `tool_calls[].userResponse`
- **AND** the server SHALL call the provider's `resumeWithToolResponse`, which for `claude-code` writes a `tool_result` line on the subprocess stdin
- **AND** the tool call's status SHALL transition to `"running"`, then to `"success"` once the provider acknowledges
- **AND** the assistant response SHALL continue streaming in the same turn, with no new model round-trip

#### Scenario: Refresh while a form is open

- **GIVEN** a tool call is in `"waiting_for_input"` and the user has not yet submitted
- **WHEN** the user reloads the page (or switches tabs and returns within session lifetime)
- **THEN** `GET /api/topics/:id/history` SHALL return the tool call with `status: "waiting_for_input"` and the same `userInputSchema` as before
- **AND** the client SHALL re-render the form, preserving the prompt
- **AND** submitting the form SHALL still resume the turn correctly

#### Scenario: Global stop while a form is open

- **GIVEN** a tool call is in `"waiting_for_input"`
- **WHEN** the user clicks the global Stop button on the chat
- **THEN** the abort handler SHALL clear the provider's pending-input registry for that session
- **AND** the partial assistant content SHALL be finalized (NOT wiped — see the abort-clear-policy guard)
- **AND** the tool call's status SHALL transition to `"error"` with reason "user aborted"

#### Scenario: Unknown user-input tool falls back to a textarea

- **GIVEN** a `tool_use` block whose name is unrecognized but whose input schema does not match a normal tool
- **WHEN** the detector classifies it as `kind: "raw"`
- **THEN** the client SHALL render a single textarea + Send button
- **AND** the submitted text SHALL be re-injected as the `tool_result` `content` verbatim

#### Scenario: Provider without resume capability fails gracefully

- **GIVEN** an active topic backed by a provider that does NOT implement `resumeWithToolResponse`
- **AND** the model emits a user-input-requiring tool call
- **WHEN** the detector recognizes it
- **THEN** the tool call SHALL transition directly to `status: "error"` with reason "provider does not support user input"
- **AND** the stream SHALL finalize normally instead of hanging
