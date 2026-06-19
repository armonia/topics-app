# Topics App — E2E Test Suite

Playwright E2E tests covering all major features (chat, sidebar, panels,
layout, tabs, terminals, browser, agents, infra). 68 `*.spec.ts` files.

For test-authoring rules (locators, waits, fixtures, test data) see
[`CONVENTIONS.md`](./CONVENTIONS.md) — the single source of truth.

## Running

```bash
# From the repo root. Tests run against http://localhost:13334
# (a dedicated test server; global-setup.ts starts/seeds it).
npx playwright test                       # all tests
npx playwright test chat.spec.ts          # a single file
npx playwright test --project=chromium    # desktop only
npx playwright test --project=mobile      # mobile-*.spec.ts at 375px
npx playwright test -g "sends message"    # by title
npx playwright show-report test-results/html-report
```

Config: [`../../playwright.config.ts`](../../playwright.config.ts) —
`baseURL` `http://localhost:13334`, `video: "on"`, sequential
(`fullyParallel: false`) to avoid races on the shared DB.

## Layout

- `*.spec.ts` — the test files (`testMatch: "*.spec.ts"`).
- `helpers.ts` — navigation helpers: `goToApp`, `openTopic`,
  `openTestChat`, `openTopicByClick`, `openTopicByDoubleClick`.
- `helpers/` — domain utilities: `api-fixtures` (test data + `cleanupAll`),
  `sse-helpers` (`mockChatStream`), `ws-helpers`, `scroll-helpers`,
  `dnd-helpers`, `seed-messages`, `gateway-health`.
- `fixtures/` — page-object fixtures; import `test` from
  `fixtures/test-fixtures.ts` (merges chat/sidebar/kanban/terminal/… via
  `mergeTests`).
- `global-setup.ts` / `global-teardown.ts` — server lifecycle + seeding.

## Writing New Tests

```typescript
import { test } from "./fixtures/test-fixtures";
import { expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { mockChatStream } from "./helpers/sse-helpers";

test.describe.serial("My feature", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "My E2E Test " + Date.now(); // unique name
    ({ id: topicId } = await createTopic(request, topicName));
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("sends a message and sees the streamed response", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible" });

    await mockChatStream(page, {
      chunks: ["Hello ", "from ", "the ", "assistant!"],
      userMessage: "test message",
    });

    await textarea.fill("test message");
    await textarea.press("Enter");

    // Semantic locator + condition-based assertion (auto-retries).
    await expect(page.locator("body")).toContainText(
      "Hello from the assistant!",
    );
  });
});
```

Note: prefer semantic locators (`getByRole`/`getByText`/`getByLabel`) and
condition-based waits. Do not use `page.waitForTimeout()` or
`waitUntil: "networkidle"` — both are banned (see `CONVENTIONS.md`).

### Common selectors
- Main area: `page.locator('[role="main"]')`
- Sidebar: `page.getByRole("treeitem", { name: /…/ })` (use the `openTopic`
  helper, which also ensures the topic is visible in the tab-driven sidebar)
- Chat input: `page.getByRole("textbox", { name: /Message input/ })`
- Buttons: `page.getByRole("button", { name: /…/ })`

## Output

Artifacts land under `test-results/` (per `playwright.config.ts`):
- `test-results/html-report/` — HTML report (`npx playwright show-report`)
- `test-results/artifacts/` — per-test video (`.webm`), screenshot on
  failure, and trace on first retry
