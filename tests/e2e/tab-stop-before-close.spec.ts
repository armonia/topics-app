import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Hermetic boundary: this file starts from the globalSetup baseline, not from
// whatever the previous spec left behind. See fixtures/hermetic.ts.
hermetic(test);

/**
 * "STOP FIRST, CLOSE AFTER."
 *
 * A tab with a turn running used to offer exactly one command under the
 * pointer, the X. Stopping the turn was possible only by hovering the LOADER,
 * which then swapped its ring for a stop square: an action hidden inside a
 * status glyph, with no name, no tooltip and no keyboard route. So the first
 * thing you could do to a working tab was kill it.
 *
 * ON A TAB they are now SUCCESSIVE STATES of one slot (CHROME-12 as modified by
 * `tab-one-slot`): while the turn runs the slot is Stop, with no Close beside
 * it; once stopped, the same slot is Close. The sidebar row keeps its rail with
 * both commands in order, stop then archive, which the second test measures.
 * The geometry of the tab's slot is measured in `tab-one-slot.spec.ts`.
 *
 * It is a BEHAVIOUR, not a layout: video on, the .webm is the evidence.
 *
 * @covers CHROME-12
 */
test.use({ video: "on" });

const BASE = E2E_BASE;

/** How long the held POST keeps the turn alive. Long enough that nothing in
 *  here races the model, short enough that a hung run still ends. */
const HELD_TURN_MS = 20_000;

test.describe.serial("Ferma prima di Chiudi", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `stop-before-close-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "the topic must have a sessionKey").toBeTruthy();
    // Two exchanges already on disk: with a single turn the stop falls into the
    // "first question, changed my mind" branch and wipes the whole chat
    // (`decideClientWipeOnStop`), which is a different subject.
    await seedMessage(request, { sessionKey, role: "user", content: "domanda di prima" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di prima" });
    await seedMessage(request, { sessionKey, role: "user", content: "e poi?" });
    await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di poi" });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * Hold the POST open: the assistant placeholder is created BEFORE the answer,
   * so the turn stays `partial` and alive — exactly the window in which a human
   * reaches for stop. The same trick `empty-turn-on-stop.spec.ts` uses.
   */
  async function startHeldTurn(page: Page, chatInput: Locator) {
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, HELD_TURN_MS));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: [DONE]\n\n",
      });
    });
    await chatInput.click();
    await chatInput.fill("ciao");
    await chatInput.press("Enter");
  }

  /** Left edge of a rendered element, in page pixels. */
  async function leftEdge(locator: Locator): Promise<number> {
    const box = await locator.boundingBox();
    expect(box, "the element must be rendered to be measured").not.toBeNull();
    return box!.x;
  }

  test("la tab in streaming offre Ferma e poi Chiudi, e lo stop ferma davvero", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-12" });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const tab = page.locator(`[data-pane-id="${topicId}"]`).first();
    await expect(tab).toBeVisible({ timeout: 15_000 });

    // Idle: one command only, and it is the one that closes.
    await tab.hover();
    await expect(tab.locator('[data-testid="pane-tab-close"]')).toBeVisible({ timeout: 5_000 });
    await expect(tab.locator('[data-testid="pane-tab-stop"]')).toHaveCount(0);

    await startHeldTurn(page, chatPage.messageInput);
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    // THE SIGNAL SITS IN THE SLOT, and the slot is the tab's last zone: the
    // command that acts on it takes the same place.
    const loader = tab.locator("[data-loader-state]");
    await expect(loader).toBeVisible({ timeout: 10_000 });
    const loaderInLastZone = await loader.evaluate((el) => {
      const slot = el.closest('[data-testid="pane-tab-slot"]');
      return !!slot && slot.parentElement?.lastElementChild === slot;
    });
    expect(loaderInLastZone, "the loader is in the slot, the tab's last zone").toBe(true);

    // Under the pointer: Stop, and no Close beside it.
    await tab.hover();
    const stop = tab.locator('[data-testid="pane-tab-stop"]');
    const close = tab.locator('[data-testid="pane-tab-close"]');
    await expect(stop).toBeVisible({ timeout: 5_000 });
    await expect(close, "never Stop and Close side by side").toHaveCount(0);
    const stopLeft = await leftEdge(stop);

    // Stop really stops: same command the composer fires.
    await stop.click();
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await expect(tab.locator("[data-loader-state]")).toHaveCount(0);

    // …and the same slot is now Close, which still closes the tab.
    await tab.hover();
    await expect(tab.locator('[data-testid="pane-tab-stop"]')).toHaveCount(0);
    await expect(close).toBeVisible({ timeout: 5_000 });
    expect(await leftEdge(close), "Close takes the place Stop had").toBe(stopLeft);
    await close.click();
    await expect(page.locator(`[data-pane-id="${topicId}"]`)).toHaveCount(0, { timeout: 10_000 });
  });

  test("la riga di sidebar dice la stessa cosa: Ferma, poi il comando che la toglie di mezzo", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-12" });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const row = page.getByRole("treeitem", { name: new RegExp(topicName) }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    await startHeldTurn(page, chatPage.messageInput);
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });
    await expect(row.locator("[data-loader-state]")).toBeVisible({ timeout: 10_000 });

    await row.hover();
    const stop = row.locator('[data-testid="topic-row-stop"]');
    await expect(stop).toBeVisible({ timeout: 5_000 });
    const archive = row.locator('[data-testid="topic-row-archive"]');
    await expect(archive).toBeVisible({ timeout: 5_000 });
    expect(await leftEdge(stop), "Ferma sta a sinistra del comando che archivia").toBeLessThan(await leftEdge(archive));

    await stop.click();
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });
    await expect(row.locator('[data-testid="topic-row-stop"]')).toHaveCount(0, { timeout: 10_000 });
  });
});
