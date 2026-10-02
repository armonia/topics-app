import { test, expect } from "./fixtures/test-fixtures";
import type { APIRequestContext, Locator } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { closeAllBrowserContexts, createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE PAGE THE AGENT OPENED STAYS IN SIGHT, AND BRINGS THE PAGE BACK.
 *
 * Before this, 602 openings of 624 (30 days to 29/09) folded inside «N actions»
 * or a finished turn's summary: the browser came up beside the chat and the
 * transcript said nothing. Seeded the way the server stores a turn, so what is
 * checked is the transcript a person reopens, not a frame in flight.
 *
 * @covers CHAT-BROWSER-01, CHAT-BROWSER-02
 */
test.describe("chat browser open marker", () => {
  let topicId = "";
  let topicName = "";
  const ctx = `cbm-${Date.now()}`;
  const other = `cbm-report-${Date.now()}`;

  const bash = (id: string) => ({
    kind: "tool",
    toolCall: { id, name: "Bash", args: { command: `echo ${id}` }, status: "success", detail: { type: "shell", command: `echo ${id}`, output: "ok" } },
  });
  const opening = (id: string, url: string, title: string, contextId: string, name?: string) => ({
    kind: "tool",
    toolCall: {
      id,
      name: "mcp__topics__open_browser_pane",
      args: { url, ...(name ? { name } : {}) },
      status: "success",
      result: `Opened browser pane at ${url} (title: ${title}) [contextId: ${contextId}]`,
    },
  });

  async function seedWindow(request: APIRequestContext, value: Record<string, unknown>): Promise<void> {
    const res = await request.put(`${E2E_BASE}/api/ui-state/topic-browser:${topicId}`, { data: value, ignoreHTTPSErrors: true });
    expect(res.ok()).toBeTruthy();
  }

  test.beforeAll(async ({ request }) => {
    topicName = `browser-marker-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const row = (role: "user" | "assistant", content: string, blocks?: unknown[]) =>
      request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, {
        data: { role, content, ...(blocks ? { blocks } : {}) }, ignoreHTTPSErrors: true,
      });
    await row("user", "apri la pagina di esempio");
    // Twelve calls, the seventh opens the browser, then the answer.
    await row("assistant", "La pagina di esempio è aperta.", [
      bash("b1"), bash("b2"), bash("b3"), bash("b4"), bash("b5"), bash("b6"),
      opening("o1", "https://example.com/", "Example Domain", ctx),
      bash("b7"), bash("b8"), bash("b9"), bash("b10"), bash("b11"),
      { kind: "text", text: "La pagina di esempio è aperta." },
    ]);
    await row("user", "e il report?");
    // Three openings of one context and one of another: two markers.
    await row("assistant", "Ecco il report.", [
      opening("p1", "https://example.com/a", "A", ctx), bash("p-b1"),
      opening("p2", "https://example.com/b", "B", ctx),
      opening("p3", "https://example.com/c", "C", ctx),
      opening("r1", "https://example.org/", "Report page", other, "Report"),
      { kind: "text", text: "Ecco il report." },
    ]);
  });
  test.afterAll(async ({ request }) => {
    await closeAllBrowserContexts(request).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
    // The page lives in the topic's window, which the X has put away.
    await seedWindow(request, {
      mode: "hidden", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
      tabs: [{ contextId: ctx, url: "https://example.com/c", title: "C", openedBy: "agent" }],
      activeContextId: ctx, promoted: [],
    });
  });

  /** `a` comes before `b` in the document. */
  async function precedes(a: Locator, b: Locator): Promise<boolean> {
    const handle = await b.elementHandle();
    return a.evaluate((el, other) => !!(el.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING), handle);
  }

  test("the marker stays in sight, takes the page back from a hidden window, and reopens it once closed", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // Finished turn: the work folds, the marker does not, and is not counted.
    const fold = page.getByTestId("turn-work-fold").first();
    await expect(fold).toHaveAttribute("data-actions", "11", { timeout: 15_000 });
    await expect(fold).toHaveAttribute("data-open", "false");
    const marker = page.locator(`[data-testid="browser-open-marker"][data-context-id="${ctx}"]`).first();
    await expect(marker).toBeVisible();
    await expect(marker.getByTestId("browser-open-marker-title")).toHaveText("Example Domain");
    await expect(marker.getByTestId("browser-open-marker-host")).toHaveText("example.com");
    const answer = page.getByText("La pagina di esempio è aperta.").last();
    expect(await precedes(fold, marker), "the marker sits after the folded work").toBe(true);
    expect(await precedes(marker, answer), "and before the answer").toBe(true);

    // Three openings of one context are one marker; another context is its own.
    const markers = page.getByTestId("browser-open-marker");
    await expect(markers).toHaveCount(3);
    const coalesced = markers.nth(1);
    await expect(coalesced.getByTestId("browser-open-marker-title")).toHaveText("C");
    await coalesced.getByTestId("browser-open-marker-pages").click();
    await expect(coalesced.getByTestId("browser-open-marker-page-list").locator("li")).toHaveText([/^A/, /^B/, /^C/]);
    await expect(markers.nth(2).getByTestId("browser-open-marker-title")).toHaveText("Report");
    await expect(markers.nth(2)).toHaveAttribute("data-state", "closed");

    // In a window put away: the click brings it back minimised, on that sheet.
    await expect(marker).toHaveAttribute("data-state", "window", { timeout: 10_000 });
    const windowEl = page.getByTestId("topic-browser-window");
    await expect(windowEl).toBeHidden();
    await marker.getByTestId("browser-open-marker-go").click();
    await expect(windowEl).toBeVisible({ timeout: 10_000 });
    await expect(windowEl).toHaveAttribute("data-mode", "min");
    await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctx}"]`)).toHaveAttribute("data-active", "true");
    await expect(page.locator('[data-pane-id^="browser:"]')).toHaveCount(0);

    // Closed from the window: the marker says so without a reload...
    await page.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctx}"] [data-testid="topic-browser-tab-close"]`).click();
    await expect(marker).toHaveAttribute("data-state", "closed", { timeout: 10_000 });
    // ...and the click reopens it in the topic's window, on the same context.
    await marker.getByTestId("browser-open-marker-go").click();
    await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctx}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(marker).toHaveAttribute("data-state", "window", { timeout: 10_000 });
    await expect(page.locator('[data-pane-id^="browser:"]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("chat-browser-open-marker.png") });
  });
});
