## Context

The Topics App has a complete tool call and media rendering pipeline: DB schema stores `tool_calls` JSON and `media` JSON on messages, the server deserializes and returns them in the API, and the client renders `ToolCallBadge`/`ToolCallsList` and `MediaImage`/`MediaFile`/`MediaAudio` components. Current E2E tests mock the SSE/WS layer, bypassing the real server entirely. A bug in gateway event filtering (CHAT-REL-04 sentinel runId) silently broke tool calls for weeks without any test detecting it.

The test server runs on port 13334 with its own SQLite database at `tests/e2e/data/`. Tests can seed messages directly into this DB and also interact with the real chat endpoint.

## Goals / Non-Goals

**Goals:**
- Verify that messages with `tool_calls` in the DB render ToolCallBadge components in the DOM
- Verify that messages with `media` paths render MediaImage/MediaFile components
- Verify that tool call expand/collapse interaction works on real rendered badges
- Verify that a live chat message flowing through the real server pipeline produces visible tool calls
- All tests run against the real test server (port 13334) with no SSE/WS mocking

**Non-Goals:**
- Testing the AI model itself (we can't control what tools it uses)
- Testing every edge case of tool call rendering (the mock-based tests already cover that)
- Replacing existing mock-based tests (they stay for fast, deterministic coverage)

## Decisions

### 1. Seed messages via API, not direct DB writes
**Decision:** Use the existing `POST /api/topics/:id/messages` endpoint (or direct DB insert via test helper) to seed messages with tool_calls and media into the test database before navigating.
**Why:** API seeding tests the full deserialization path. Direct DB insert is faster but skips server-side validation. We'll use direct DB for speed since the deserialization path is trivially testable.
**Alternative:** Mock API responses — rejected because this is exactly what current tests do and it missed the pipeline bug.

### 2. Live tool call test uses a prompt that reliably triggers tool use
**Decision:** Send a message like "Read the file package.json and tell me the project name" which reliably triggers the Read tool on any AI model. Seed a small test file via the files API first.
**Why:** We need determinism. File-reading is the simplest, most reliable tool invocation.
**Alternative:** Mock the gateway response — rejected (defeats the purpose).
**Fallback:** If the gateway is unavailable or the AI doesn't use a tool, the test should be marked as `test.skip()` with a clear reason, not fail.

### 3. Separate test file, not extending existing
**Decision:** Create `tests/e2e/real-tool-calls.spec.ts` as a standalone file.
**Why:** These tests are slower (real server, real AI) and may be flaky. Keeping them separate allows running them independently and marking the live test as `test.slow()`.

### 4. Test both history rendering and live streaming
**Decision:** Two test groups:
1. **History rendering** (deterministic): Seed DB with messages containing tool_calls/media, load topic, verify DOM
2. **Live streaming** (best-effort): Send real message, wait for tool call badge to appear, verify rendering

**Why:** History rendering catches deserialization/rendering bugs. Live streaming catches pipeline bugs (SSE parsing, WS broadcast, gateway filtering).

## Risks / Trade-offs

- **Live test flakiness** → Mitigation: Mark as `test.slow()`, add generous timeouts, skip if gateway unavailable
- **Test DB pollution** → Mitigation: Create dedicated test topic, clean up in afterAll
- **Gateway unavailability** → Mitigation: Check gateway health before live test, skip with annotation if down
