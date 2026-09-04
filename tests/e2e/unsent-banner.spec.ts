import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * The banner for the messages that never reached the server.
 *
 * What it used to be: one amber pill reading "1 message not sent", in English
 * whatever the chosen language, with a Retry that resent every chat at once.
 * You could see that something had been lost but not WHICH chat, and there was
 * no way to get there. What this file pins down is the answer: one row per
 * chat, named after the topic, clicking the row focuses that chat, and the
 * per-row Retry resends ONLY that chat.
 *
 * How the messages get there: the DURABLE expired queue is seeded in
 * localStorage (`messages-expired-queue`, see
 * `client/src/hooks/outboundQueue.ts`), which is exactly the state a send that
 * never landed leaves behind and the only state the banner reads. Seeding the
 * outbound queue instead would prove nothing here: the drain that expires an
 * item runs on a WebSocket RECONNECT, so the item would just sit there.
 * Whether a message expires at all is decided by `decideQueuedMessage`, which
 * has its own unit tests in `client/src/hooks/outboundQueue.test.ts`.
 */
test.use({ video: "on" });

const OUTBOUND_KEY = "messages-outbound-queue";
const EXPIRED_KEY = "messages-expired-queue";

test.describe.serial("Unsent messages banner", () => {
  let firstId = "";
  let secondId = "";
  let firstName = "";
  let secondName = "";
  let firstSession = "";
  let secondSession = "";

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    firstName = `unsent-one-${stamp}`;
    secondName = `unsent-two-${stamp}`;
    firstId = (await createTopic(request, firstName)).id;
    secondId = (await createTopic(request, secondName)).id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as {
      topics: Record<string, { id: string; sessionKey: string }>;
    };
    const all = Object.values(topics);
    firstSession = all.find((t) => t.id === firstId)?.sessionKey ?? "";
    secondSession = all.find((t) => t.id === secondId)?.sessionKey ?? "";
    expect(firstSession).toBeTruthy();
    expect(secondSession).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (firstId) await deleteTopic(request, firstId);
    if (secondId) await deleteTopic(request, secondId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [firstId, secondId]);
  });

  /** Every send fails, and the bodies are recorded so a retry can be measured. */
  async function failEverySend(page: import("@playwright/test").Page) {
    const sent: string[] = [];
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { messages?: { content?: string }[] };
      sent.push(body?.messages?.[body.messages.length - 1]?.content ?? "");
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    return sent;
  }

  /** Two chats worth of messages, already expired and waiting in the banner. */
  async function seedExpiredQueue(
    page: import("@playwright/test").Page,
    entries: { sessionKey: string; content: string }[],
  ) {
    await page.addInitScript(
      ([outboundKey, expiredKey, payload]: [string, string, string]) => {
        const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const items = (JSON.parse(payload) as { sessionKey: string; content: string }[]).map(
          (entry, index) => ({ ...entry, timestamp: stale, id: `e2e-unsent-${index}` }),
        );
        window.localStorage.setItem(expiredKey, JSON.stringify(items));
        window.localStorage.removeItem(outboundKey);
      },
      [OUTBOUND_KEY, EXPIRED_KEY, JSON.stringify(entries)] as [string, string, string],
    );
  }

  const banner = (page: import("@playwright/test").Page) => page.getByTestId("unsent-banner");
  const rows = (page: import("@playwright/test").Page) => page.getByTestId("unsent-row");

  test("names the chat, opens it, and retries only that chat", async ({ page }) => {
    const sent = await failEverySend(page);
    await seedExpiredQueue(page, [
      { sessionKey: firstSession, content: "primo messaggio non inviato" },
      { sessionKey: secondSession, content: "secondo messaggio non inviato" },
    ]);
    await goToApp(page);

    await expect(banner(page)).toBeVisible({ timeout: 20_000 });
    await expect(rows(page)).toHaveCount(2);

    const firstRow = page.locator(`[data-testid="unsent-row"][data-session-key="${firstSession}"]`);
    await expect(firstRow).toContainText(firstName);
    await expect(firstRow).toContainText("primo messaggio non inviato");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: "/Users/zorahrel/.topics/media/unsent-banner-desktop.png" });

    // Click the row: the chat it names comes to the front as the active tab.
    await firstRow.getByTestId("unsent-row-open").click();
    await expect(page.getByTestId(`pane-tab-${firstId}`)).toHaveAttribute("data-active", "true", {
      timeout: 15_000,
    });

    // Per-row retry resends that chat only.
    sent.length = 0;
    await firstRow.getByTestId("unsent-row-retry").click();
    await expect.poll(() => sent.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(sent.join(" | ")).toContain("primo messaggio non inviato");
    expect(sent.join(" | ")).not.toContain("secondo messaggio non inviato");

    // The other chat is still listed: retrying one must not discard the other.
    await expect(
      page.locator(`[data-testid="unsent-row"][data-session-key="${secondSession}"]`),
    ).toBeVisible();
  });

  test("per-row discard drops one chat and leaves the other", async ({ page }) => {
    await failEverySend(page);
    await seedExpiredQueue(page, [
      { sessionKey: firstSession, content: "primo messaggio non inviato" },
      { sessionKey: secondSession, content: "secondo messaggio non inviato" },
    ]);
    await goToApp(page);

    await expect(rows(page)).toHaveCount(2, { timeout: 20_000 });
    await page
      .locator(`[data-testid="unsent-row"][data-session-key="${firstSession}"]`)
      .getByTestId("unsent-row-dismiss")
      .click();
    await expect(rows(page)).toHaveCount(1);
    await expect(
      page.locator(`[data-testid="unsent-row"][data-session-key="${secondSession}"]`),
    ).toBeVisible();
  });

  test("on a phone the banner sits above the bottom bar, not on the composer", async ({ page }) => {
    await failEverySend(page);
    await seedExpiredQueue(page, [
      { sessionKey: firstSession, content: "primo messaggio non inviato" },
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await goToApp(page);

    await expect(banner(page)).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: "/Users/zorahrel/.topics/media/unsent-banner-mobile.png" });

    const box = await banner(page).boundingBox();
    expect(box).not.toBeNull();
    // Full width, and lifted by the bottom bar's own height so it cannot cover
    // the composer that writing the message again needs.
    expect(box!.width).toBeGreaterThan(370);
    const barHeight = await page.evaluate(() =>
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--mobile-chrome-h") || "0",
      ),
    );
    expect(box!.y + box!.height).toBeLessThanOrEqual(844 - barHeight + 1);
  });
});
