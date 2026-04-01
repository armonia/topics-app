## Why

The current E2E tests for tool call rendering and media attachments mock the entire server pipeline (SSE stream, WebSocket events, API responses). This means the tests pass even when the real pipeline is broken — as proven by the CHAT-REL-04 sentinel runId bug that silently dropped all tool events for weeks without any test catching it. We need real E2E tests that verify tool calls and media attachments flow from server through to the rendered UI, using actual database messages and live chat interactions.

## What Changes

- Add E2E tests that load real messages with tool_calls from the database and verify ToolCallBadge components render in the DOM
- Add E2E tests that send a real chat message triggering AI tool use and verify tool call events appear in real-time during streaming
- Add E2E tests that verify image and file attachments stored in messages render as MediaImage/MediaFile components
- Ensure the full pipeline is covered: DB storage → API response → client parsing → component rendering → user interaction (expand/collapse)

## Capabilities

### New Capabilities
- `real-tool-call-e2e`: Real E2E tests for tool call rendering — verifies the full pipeline from database/streaming through to rendered UI without mocking the server

### Modified Capabilities

## Impact

- `tests/e2e/` — new test file(s) for real tool call and media rendering verification
- `tests/e2e/helpers/` — possible new helper for seeding messages with tool_calls directly in the test database
- `server/` — no changes expected (testing existing behavior)
- `client/` — no changes expected (testing existing rendering)
