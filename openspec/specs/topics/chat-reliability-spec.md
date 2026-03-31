## Purpose

Fix critical reliability issues in the Topics → OpenClaw gateway chat flow that cause silent failures, empty responses, and stuck sessions.

## Background

Common preconditions shared across scenarios:

- Topics app running at https://localhost:3333 with gateway connected
- OpenClaw gateway running at ws://127.0.0.1:18789
- HTTP SSE path is the active chat path (`useWS = false` in topics.ts:1309)
- Gateway may return rate limits (429), overloaded errors, or empty streams

## Root Cause Analysis

The HTTP SSE chat path has 5 structural bugs:

1. **Empty response not detected**: Gateway returns `data: [DONE]` with no content (internal rate limit) — Topics finalizes with empty string, no error shown
2. **Errors not propagated to client**: `consumeGateway()` is async but HTTP response sent before it completes — stream errors only logged
3. **No stream inactivity timeout**: HTTP path has 5min request timeout but no per-chunk timeout — gateway stalls cause silent hangs
4. **Stale WS handler routing**: Session handler registered with `runId=undefined` lets old error events bleed into current request
5. **No stream cleanup timer**: Active streams only auto-expire on access — stuck streams persist indefinitely

## Requirements

### Requirement: CHAT-REL-01 — Empty response detection

The system SHALL detect when a gateway stream completes with no content and surface an error to the user.

#### Scenario: Gateway returns [DONE] with no content deltas
- **GIVEN** a chat message is sent via HTTP SSE
- **WHEN** the gateway stream returns `data: [DONE]` without any prior content delta events
- **THEN** the system sends an error message to the client: "⚠️ No response received. The AI service may be overloaded. Please try again."
- **AND** the message is stored with the error content (not empty string)
- **AND** the stream is properly cleaned up

### Requirement: CHAT-REL-02 — Stream error propagation

The system SHALL send stream errors to the client via SSE before closing the connection.

#### Scenario: Gateway read error during streaming (ECONNRESET)
- **GIVEN** a chat message is streaming via HTTP SSE
- **WHEN** the gateway connection drops (ECONNRESET, timeout, etc.)
- **THEN** the system sends `data: {"choices":[{"delta":{"content":"⚠️ Connection lost..."}}]}` to the client
- **AND** sends `data: [DONE]`
- **AND** cleans up the stream and session handler

#### Scenario: Gateway returns non-200 after stream started
- **GIVEN** a chat message is sent
- **WHEN** the gateway returns an error status (429, 500, etc.)
- **THEN** the error message is shown to the user (existing behavior, verify it works)

### Requirement: CHAT-REL-03 — Stream inactivity timeout

The system SHALL timeout HTTP streams that receive no data for an extended period.

#### Scenario: Gateway stalls during streaming
- **GIVEN** a chat message is streaming via HTTP SSE
- **WHEN** no data is received from the gateway for 60 seconds
- **THEN** the system sends a timeout error message to the client
- **AND** aborts the gateway fetch
- **AND** cleans up the stream and session handler

### Requirement: CHAT-REL-04 — WS handler isolation

The system SHALL not route stale WS events to the current HTTP stream handler.

#### Scenario: Old error event arrives for current session
- **GIVEN** an HTTP SSE stream is active with a registered WS handler
- **WHEN** a WS event with `state=error` arrives from a previous run
- **THEN** the event is ignored (not routed to current handler)
- **AND** no error is shown for the current request

**Implementation**: Register HTTP-path WS handlers with a unique sentinel `runId` (e.g., `http:{uuid}`) so that events from gateway runs (which have their own runIds) don't match.

### Requirement: CHAT-REL-05 — Active stream cleanup

The system SHALL periodically clean up stale active streams, not only on access.

#### Scenario: Stream stuck after gateway crash
- **GIVEN** a stream is active for a session
- **WHEN** the stream has had no activity for 3 minutes
- **THEN** the system automatically removes it from `activeStreams`
- **AND** broadcasts `stream:end` to connected clients

**Implementation**: Add a `setInterval` (every 60s) that iterates `activeStreams` and removes expired entries.

## Out of Scope

- Changing the primary model from Opus (rate limit is an Anthropic API issue, not a Topics bug)
- The `LiveSessionModelSwitchError` bug in OpenClaw gateway (upstream issue)
- WS-based chat path (currently disabled, separate spec if re-enabled)

## Files to Modify

1. `server/routes/topics.ts` — Lines 1639-1840 (HTTP SSE fallback path)
2. `server/utils.ts` — Stream management (add cleanup timer)
3. `server/gateway-ws.ts` — Session handler registration (runId isolation)
