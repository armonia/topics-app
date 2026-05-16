## 1. Test Helpers

- [x] 1.1 Create `tests/e2e/helpers/seed-messages.ts` with a `seedMessage()` function that inserts a message directly into the test server's SQLite database via a test-only API endpoint or direct HTTP call. Must support `toolCalls` and `media` fields.
- [x] 1.2 Create `tests/e2e/helpers/gateway-health.ts` with a `isGatewayAvailable()` function that checks if the AI gateway is reachable (GET `/api/system/status` and check `gateway.online`).

## 2. History Rendering Tests (REAL-TC-01, REAL-TC-02)

- [x] 2.1 Create `tests/e2e/real-tool-calls.spec.ts` with a `beforeAll` that creates a test topic and seeds messages with tool_calls (success, error, multiple) and media (image, file) via the seed helper.
- [x] 2.2 Write test: seeded message with tool call renders badge with tool name (REAL-TC-01 scenario 1)
- [x] 2.3 Write test: tool call badge expands to show args and result on click (REAL-TC-01 scenario 2)
- [x] 2.4 Write test: error tool call renders with error status and error message (REAL-TC-01 scenario 3)
- [x] 2.5 Write test: multiple tool calls render in document order by contentOffset (REAL-TC-01 scenario 4)
- [x] 2.6 Write test: message with image media renders MediaImage with correct src (REAL-TC-02 scenario 1) — mock `/uploads/` route for image response
- [x] 2.7 Write test: message with file media renders MediaFile with filename (REAL-TC-02 scenario 2)

## 3. Live Streaming Test (REAL-TC-03)

- [x] 3.1 Write test: check gateway availability, skip if offline (REAL-TC-03 scenario 2)
- [x] 3.2 Write test: send real message triggering tool use, verify tool call badge appears in DOM within 30s (REAL-TC-03 scenario 1) — mark as `test.slow()`

## 4. Cleanup and Verification

- [x] 4.1 Add `afterAll` cleanup that deletes the test topic and seeded messages
- [x] 4.2 Run full test suite `npx playwright test tests/e2e/real-tool-calls.spec.ts` and verify all history tests pass, live test passes or skips gracefully
