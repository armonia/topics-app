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

#### Scenario: The stall judge is not asked while background work runs
- **GIVEN** a headless turn under the stall detector whose session's CLI still reports background work (an Agent, a Bash, a Monitor)
- **WHEN** the idle window expires
- **THEN** the detector SHALL rearm without asking the judge, as for a human, the checks or a freeze
- **AND** once that work reports its end, or thirty minutes pass with no news of it, the judge SHALL be asked again

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

#### Scenario: a delivery waiting on its own pre-review checks
- **GIVEN** a live turn whose running tool is `update_task(status='review')`, and the board is running (or queuing) the pre-review checks for the card bound to that session
- **WHEN** that tool has been running longer than the hung-tool cap
- **THEN** the sweeper extends the stream instead of closing it as hung
- **AND** the provider is not aborted

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

## ADDED Requirements

### Requirement: CHAT-REL-07 - A verdict reads as a sentence, its payload stays behind a fold

The chat SHALL show the provider's own sentence in the amber banner, and SHALL
keep the raw payload available instead of printing it or discarding it.

Measured on 2026-09-22, on two sets that are not the same. The wide scan takes
every row carrying the ⚠️ marker anywhere, 2101 of them, and 126 carried a
provider JSON object inline (91 whole, 35 stored truncated), with a further 36
whose braces are not JSON at all. The route the banner actually reads,
`turnErrorOf` (a leading ⚠️, or an `error` block), is narrower: 1996 rows and
123 payloads, 88 whole and the same 35 truncated, and none of those 36
brace-bearing prose rows.

Either way the one sentence that mattered sat between two braces and a null
request id. The 35 truncated ones are cut off at a fixed 309 characters, so the
object never closes and `JSON.parse` can never see them. ALL of them read as a
sentence, by two different routes described below, and the brace-bearing prose
rows SHALL keep printing exactly as they are. Requirements below are verified
against the wide scan: it is a superset of the banner's rows, so proving them
there proves them for the banner.

#### Scenario: the provider refused with a JSON payload
- **GIVEN** a verdict reading `API 401: {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}. The token could not be renewed either: run `claude` then /login once, then retry.`
- **WHEN** the banner renders it
- **THEN** the visible sentence keeps the label, the provider message and the advice, and contains no brace
- **AND** the payload is reachable, pretty-printed, from a fold that starts closed
- **AND** the fold offers a copy of the payload

#### Scenario: a verdict that is already prose
- **GIVEN** a verdict with no JSON object in it
- **THEN** the banner prints it unchanged and shows no fold

#### Scenario: a payload stored truncated, message closed before the cut
- **GIVEN** a verdict cut at 309 characters, `API 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.112: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: toolu_01WA8ekA3YdZkzy9R79FxFk6. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message."},"request_id":"req_011C`
- **WHEN** the banner renders it
- **THEN** the visible sentence is the label plus the provider message, with no brace and no key name in it
- **AND** the fold holds the payload VERBATIM, cut included, and is copyable
- **AND** the fold is labelled as truncated, so nobody pastes it into a bug report believing it is the whole envelope

#### Scenario: a payload stored truncated, message cut mid-sentence
- **GIVEN** the commoner shape, 26 of the 35, where the cut fell inside the message so its quote never closes
- **THEN** the sentence is still shown, and ends with an ellipsis marking that it was cut
- **AND** a cut landing inside an escape sequence drops that half-written character rather than failing the whole read

#### Scenario: the payload is read, never repaired
- **GIVEN** any truncated payload
- **THEN** the system SHALL NOT close braces, fill in missing fields, or re-serialise the object
- **AND** the `message` string SHALL be lifted out by a scanner that respects quotes and escapes, recognising keys only where a key can structurally be, so a message quoting `"message":"` inside itself cannot hijack the read
- **AND** a truncated object that yields no readable sentence SHALL be printed untouched, as it always was

A repaired payload is a payload the provider never sent. It would be pasted
into bug reports as though it were real, which is a worse failure than the
unreadable line this requirement exists to fix.

#### Scenario: braces that are not JSON
- **GIVEN** a verdict quoting a path or a shell snippet with braces
- **THEN** the text is left alone, because guessing would eat prose
- **AND** an unclosed brace with no JSON object behind it is left alone too: the truncated-payload rule requires an object that opens with a quoted key, so prose never reaches it

### Requirement: CHAT-REL-08 - A turn refused before it starts throws a sentence, and keeps its code

`chatApi.sendMessage` SHALL open the server's refusal envelope the same way
`request()` does: the `error` field becomes the thrown message, and every other
field of the body SHALL ride on the `ApiError` so callers can branch on it.

A turn refused before it starts is never persisted, so this throw is the only
text the reader gets. It used to be `response.text()` verbatim, which is why a
503 reached the chat as an escaped JSON object.

THE COUPLED HALF, and it is not optional. `useChat` tells the two 409s apart
(`duplicate_message`, which must NOT be re-queued, from `stream_in_flight`,
which must) and it did so by searching the thrown message for the code, which
only worked while the message was the raw body. The sentence and the code are
one requirement: shipping the sentence alone re-queues a message the server has
already accepted, producing the duplicate the idempotency key exists to prevent.

#### Scenario: the provider is not connected
- **GIVEN** `/api/chat` answers 503 with `{"error":"Provider \"jcode\" is unavailable. Connect it in Settings or choose another provider.","code":"provider_unavailable","provider":"jcode"}`
- **WHEN** `chatApi.sendMessage` rejects
- **THEN** the thrown message is the provider sentence, with no brace and no escaped quote
- **AND** `status` is 503, `code` is `provider_unavailable`, and `provider` is `jcode`

#### Scenario: the server already has this message
- **GIVEN** `/api/chat` answers 409 with `{"error":"message already accepted","code":"duplicate_message","messageId":"msg_42"}`
- **THEN** the thrown error carries `code: "duplicate_message"` and `messageId: "msg_42"`
- **AND** the caller decides on the code, never on the wording of the message

#### Scenario: a body that is not JSON
- **GIVEN** a plain-text 502 from a proxy in front of the server
- **THEN** the body is thrown as it came, because it is the most informative thing available
- **AND** an empty body falls back to the HTTP status text rather than an empty banner
