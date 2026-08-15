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
- `await expect.poll(() => page.evaluate(...)).toBeGreaterThanOrEqual(n)` — when the
  condition is a number the page can report but no locator can express

NEVER use `page.waitForTimeout(N)` — it causes flaky tests.
NEVER use `waitUntil: "networkidle"` — it hangs with WebSocket/SSE.

### The ratchet that makes this rule real
This rule was written down and then not enforced: on 15/08/2026 the suite held
**176 `waitForTimeout` calls across 82 files — about 151 s of pure sleeping per
pass**, and a large share of the flakiness budget. `scripts/check-e2e-sleeps.ts`
(`bun run check:sleeps`, wired into the static guard rails in
`.github/workflows/ci.yml`) freezes that count **per file** in
`scripts/e2e-sleeps-baseline.json` and fails when a file gains a call or a new
file introduces one. Going down never fails — it prints the line asking you to
re-run with `--update-baseline`.

So: converting one is always welcome, adding one is a conversation with a human.
Do not raise a baseline number to get CI green.

### How to convert one — the worked example
`dictation-real-mic.spec.ts` used to record with `await page.waitForTimeout(5_000)`
and the comment "the WAV lasts ~3.5 s, five seconds contain it". That is a bet on
two things at once: that capture starts immediately, and that five seconds are
enough. When capture started late the sleep expired anyway, the blob held half a
phrase, and the red surfaced ninety seconds later pointing at the transcriber.

The fix is not a longer sleep, it is naming the real precondition — *the
microphone has delivered a whole phrase* — and measuring it. The spec now taps
the same `MediaStream` the app records, counts seconds of delivered samples in a
zero-gain analysis branch, and polls until they cover the fixture's own duration
(read from the WAV header, not copied into a constant). It is the audio clock,
not the wall clock: late capture makes the test wait longer instead of shipping a
short blob, and a silent stream fails saying exactly that.

The general shape:
1. Write down what the sleep is really waiting for, in one sentence.
2. Find the thing that already reports it (a locator, a DOM attribute, a counter
   the page can expose) — or install a probe that observes it honestly.
3. Poll that, with a generous timeout. A generous timeout on a real condition
   costs nothing when the condition arrives early; a fixed sleep always costs.

The one exception in the tree is flag-gated: `E2E_EVIDENCE=1` pauses between
captions of a delivery video. Nothing is being waited for there — the page is
already still, a human is being given time to read.

## Helpers
- Domain helpers: `tests/e2e/helpers/` (dnd, scroll, ws, api-fixtures)
- Page objects: `tests/e2e/fixtures/` (import `test` from `test-fixtures.ts`)
- Navigation: `tests/e2e/helpers.ts` (goToApp, openTopic, openTestChat)

## Test Data
- Create via API fixtures (helpers/api-fixtures.ts), never direct DB
- Use unique names: `"Test Topic " + Date.now()`
- Clean up in afterAll via cleanupAll()
