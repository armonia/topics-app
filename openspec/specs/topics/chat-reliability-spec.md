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

The system SHALL detect a stalled stream and SHALL finalize it — but SHALL NOT
kill a turn whose provider process is still alive.

> **Rewritten to match what was built, and why.** The original text said a
> 60-second silence aborts the fetch. The implementation deliberately does not:
> a healthy turn can be silent for minutes while a tool runs or the CLI
> auto-compacts, and killing it would lose work the user is waiting for — the
> terminal `claude` has no wall-clock session kill either. What ships instead is
> a three-stage watchdog that says "this is slowing down" long before it decides
> anything is broken, and only finalizes a turn whose process is gone.

#### Scenario: A silent stream is announced before it is judged
- **GIVEN** a chat message is streaming and no tool call is running
- **WHEN** no data arrives from the provider for 60 seconds
- **THEN** the stream is annotated as slow and the client is told
- **AND** the stream is NOT finalized

#### Scenario: Output resumes during the grace window
- **GIVEN** a stream that has been annotated as slow
- **WHEN** any provider event arrives within the following 60 seconds
- **THEN** the slow annotation is stripped and the stream returns to streaming

#### Scenario: The timer is suspended while a tool runs
- **GIVEN** at least one tool call is in `running` state
- **THEN** the soft timer is not armed, so a long tool never trips the watchdog

#### Scenario: Grace expires on a DEAD process
- **GIVEN** the grace window expires with no further events
- **WHEN** the provider process is no longer alive
- **THEN** the stream is finalized as timed out and the session handler cleaned up

#### Scenario: Grace expires on a LIVE process
- **GIVEN** the grace window expires with no further events
- **WHEN** the provider process is still alive (auto-compaction, a long tool)
- **THEN** the grace window is extended instead of finalizing
- **AND** only the 30-minute hard cap, and only on a dead process, ends the turn

### Requirement: CHAT-REL-06 — A transient API failure is retried, not reported

The native runtime SHALL try a failed model call again when the failure is the
API's and transient, with exponential backoff and a bounded number of attempts,
and SHALL surface the failure only once the attempts are spent. It SHALL renew
the OAuth token and retry once on a 401. It SHALL NOT retry a failure that
occurred after content was already shown, nor a request the API rejected as
malformed, nor a turn the user stopped.

> **Why.** On 2026-09-03 two turns in the same chat died within a second of
> Enter: an `overloaded_error` delivered inside a 200 as the first SSE event,
> and a 401 on a token the user's CLI had just rotated. Claude Code recovers
> from both without anyone noticing; here the chat showed a ⚠️ and a Retry
> button, and the goal the person had declared stayed unattended.

#### Scenario: Overload inside a 200
- **GIVEN** the API answers a model call with an SSE `error` event of type `overloaded_error` before any content block
- **WHEN** the native runtime receives it
- **THEN** it waits and sends the same call again
- **AND** the turn ends normally if a later attempt succeeds
- **AND** the chat shows no error

#### Scenario: Transient HTTP status
- **GIVEN** the API answers 429, 5xx or 529
- **THEN** the call is retried with a wait that doubles on each attempt, capped, honouring `retry-after` as a floor

#### Scenario: Attempts run out
- **GIVEN** every attempt failed transiently
- **THEN** the turn ends in error and the message says how many attempts were spent

#### Scenario: Rotated token
- **GIVEN** the API answers 401 with a token that is still fresh by its expiry
- **WHEN** the credentials file already carries a different token
- **THEN** the call is repeated at once with the token from the file
- **AND** a second 401 is not retried

#### Scenario: Not retried
- **GIVEN** a 400, or a stream error after a content block was emitted, or a turn the user stopped during the wait
- **THEN** no further call is made

#### Scenario: The wait is visible
- **GIVEN** the runtime is waiting before a retry
- **THEN** the client is told (`stream:retry`) and the activity indicator says so
- **AND** the silence watchdog counts the wait as life
- **AND** the notice clears when data flows again (`stream:resumed`)

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

### Requirement: STREAM-SNAPSHOT-01 — The streaming snapshot walks the registry, not the topics table

`GET /api/topics/streaming` SHALL answer from the in-memory registry of active
streams: for each entry that is still streaming it SHALL look up the topic by
its session key, and it SHALL NOT hydrate the whole topics table to do so.
With no active stream it SHALL run no query and answer an empty list.

A stale entry (one the registry no longer reports as streaming) SHALL be
skipped and SHALL NOT be deleted by this route: the sweeper of CHAT-REL-05
owns the finalisation. An entry whose topic row is gone SHALL be omitted, as
the old filter omitted it.

> **Why.** Every 15s each client asked this route, and the route answered by
> loading EVERY topic (1,452 rows plus four relation-table scans) to keep the
> zero, one or two whose session key sat in a Map with as many entries. That
> churn is what kept the idle server warm.

#### Scenario: two live streams
- **GIVEN** two active streams and three topics
- **WHEN** the snapshot is requested
- **THEN** the answer lists the two streaming topics
- **AND** the topics table was not loaded, and the session-key lookup ran once per stream

#### Scenario: a stale stream
- **GIVEN** an entry the registry reports as no longer streaming
- **THEN** it is not in the answer, and it is still in the registry

## Out of Scope

- Changing the primary model from Opus (rate limit is an Anthropic API issue, not a Topics bug)
- The `LiveSessionModelSwitchError` bug in OpenClaw gateway (upstream issue)
- WS-based chat path (currently disabled, separate spec if re-enabled)

## Files to Modify

1. `server/routes/topics.ts` — Lines 1639-1840 (HTTP SSE fallback path)
2. `server/utils.ts` — Stream management (add cleanup timer)
3. `server/gateway-ws.ts` — Session handler registration (runId isolation)
