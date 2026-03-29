# E2E Test Conventions

## data-testid Naming
Convention: `data-testid="[component]-[element]"`
Examples: `sidebar-topic-list`, `chat-message-input`, `kanban-board`

Prefer semantic locators (getByRole, getByText, getByLabel) when possible.
Use data-testid only for elements with no semantic role.

## No waitForTimeout
All waits must be condition-based:
- `await locator.waitFor({ state: "visible" })`
- `await expect(locator).toBeVisible()`
- `await page.waitForSelector(selector)`

NEVER use `page.waitForTimeout(N)` — it causes flaky tests.
NEVER use `waitUntil: "networkidle"` — it hangs with WebSocket/SSE.

## Helpers
- Domain helpers: `tests/e2e/helpers/` (dnd, scroll, ws, api-fixtures)
- Page objects: `tests/e2e/fixtures/` (import `test` from `test-fixtures.ts`)
- Navigation: `tests/e2e/helpers.ts` (goToApp, openTopic, openTestChat)

## Test Data
- Create via API fixtures (helpers/api-fixtures.ts), never direct DB
- Use unique names: `"Test Topic " + Date.now()`
- Clean up in afterAll via cleanupAll()
