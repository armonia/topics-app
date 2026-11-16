/**
 * The Muse provider in the UI: its card in Settings → Providers, its models
 * in the chat ModelSelector, and a turn on a muse model answering on the topic.
 *
 * The bench seeds muse (stub binary + fake login + two cached models) in
 * `scripts/start-test-server.sh`, so this file asserts the LIVE snapshot:
 * no route mock, no conditional skip. A red here means the product regressed,
 * not the machine (MUSE-01: without the stub the provider would not register
 * at all, and every assertion below names it).
 *
 * @covers MUSE-04
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { beat, didascalia } from "./helpers/evidence";
import { openHomePanel } from "./helpers/user-menu";
import { hermetic } from "./fixtures/hermetic";

// Hermetic confine: this file restarts from the globalSetup baseline, not from
// whatever panes the previous specs left behind. See fixtures/hermetic.ts.
hermetic(test);

test.describe.serial("Muse provider picker", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Muse E2E " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("MUSE-04a: Settings → Providers shows the Muse card, ready with 2 models", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "MUSE-04" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openHomePanel(page, "providers");

    const card = page.getByTestId("provider-card-muse");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("provider-card-fact")).toContainText("Muse");
    await expect(card.getByTestId("provider-card-fact")).toContainText("2");
    // No `muse-` family in modelMaker: the company is named by the provider
    // that offers it (the designed fallback).
    await expect(card.getByTestId("provider-card-makers")).toContainText("Muse");
    await didascalia(page, "Muse è tra i provider, pronto con 2 modelli");
    await beat(page);

    await card.getByTestId("provider-card-open").click();
    await expect(page.getByTestId("provider-detail-program")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("provider-detail-program")).toContainText("muse");
    await expect(page.getByTestId("provider-detail-default-model")).toBeVisible({ timeout: 5_000 });
    await didascalia(page, "Percorso programma e modello di default");
    await beat(page);
  });

  test("MUSE-04b: the chat ModelSelector lists the muse models", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "MUSE-04" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const pickerBtn = page.getByTestId("provider-model-picker");
    await pickerBtn.waitFor({ state: "visible", timeout: 5_000 });
    await pickerBtn.click();

    const popover = page.getByTestId("provider-model-popover");
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    const current = popover.locator('[data-testid="model-row"][data-provider="muse"][data-model="muse-spark-1.3-contributor"]');
    await expect(current).toBeVisible({ timeout: 5_000 });
    await didascalia(page, "I modelli muse nel selettore della chat");
    await beat(page);
    await page.keyboard.press("Escape");
  });

  test("MUSE-04c: choosing a muse model answers on the topic", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "MUSE-04" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Campo del messaggio/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    const pickerBtn = page.getByTestId("provider-model-picker");
    await pickerBtn.waitFor({ state: "visible", timeout: 5_000 });
    await pickerBtn.click();
    const popover = page.getByTestId("provider-model-popover");
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    const current = popover.locator('[data-testid="model-row"][data-provider="muse"][data-model="muse-spark-1.3-contributor"]:not([aria-disabled="true"])');
    await expect(current).toBeVisible({ timeout: 5_000 });
    await current.click();

    // THE TURN IS READ ON THE REQUEST EVENT, NOT ON A ROUTE HANDLER.
    //
    // `boot.js` registers `/sw.js` on every secure origin, and `localhost` is
    // one: from the moment that worker activates, the next load of the page is
    // CONTROLLED by it. A request that passes through a service worker is not
    // delivered to `page.route`, so the old `page.route("**/api/chat")` capture
    // saw nothing exactly in those runs: the POST went out for real, the muse
    // stub answered, the bubble appeared, and `capturedBody` stayed null until
    // the poll gave up (measured 2026-11-13, webkit, 5 reds out of 20, and
    // `navigator.serviceWorker.controller` non-null in every single one of
    // them and null in every green). Whether the worker has taken the page over
    // by now depends on how many reloads the helpers did before: a race on the
    // machine, with nothing to say about the product.
    //
    // `page.waitForRequest` reports the request either way, worker or no
    // worker, and reads the same body the route handler read. It is armed
    // BEFORE the Enter, so the send cannot slip through between the two.
    const chatPost = page.waitForRequest(
      (req) => new URL(req.url()).pathname === "/api/chat" && req.method() === "POST",
      { timeout: 15_000 },
    );

    await textarea.click();
    await textarea.fill("ping");
    await textarea.press("Enter");

    const postData = (await chatPost).postData();
    expect(postData, "POST /api/chat carried no body").toBeTruthy();
    const capturedBody = JSON.parse(postData!);
    expect(capturedBody.provider).toBe("muse");
    expect(capturedBody.model).toContain("muse-spark");
    // The stub answers for real through the stack: nothing is mocked on the way back.
    await expect(page.getByTestId("chat-message").filter({ hasText: "e2e-muse-ok" }).first())
      .toBeVisible({ timeout: 30_000 });
    await didascalia(page, "Il topic risponde sul modello muse");
    await beat(page);
  });
});
