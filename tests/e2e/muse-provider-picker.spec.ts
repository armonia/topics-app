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
import { expect, type Route } from "@playwright/test";
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
    // that offers it (the designed fallback, as for OpenClaw).
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
    // A new topic chooses nothing, so the Muse section is closed: its heading opens it.
    await popover.getByTestId("model-section-provider:muse").getByTestId("model-section-toggle").click();
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

    let capturedBody: any = null;
    await page.route("**/api/chat", async (route: Route) => {
      if (route.request().method() === "POST") {
        try { capturedBody = JSON.parse(route.request().postData() ?? ""); } catch {}
      }
      return route.fallback();
    });

    const pickerBtn = page.getByTestId("provider-model-picker");
    await pickerBtn.waitFor({ state: "visible", timeout: 5_000 });
    await pickerBtn.click();
    const popover = page.getByTestId("provider-model-popover");
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    // A new topic chooses nothing, so the Muse section is closed: its heading opens it.
    await popover.getByTestId("model-section-provider:muse").getByTestId("model-section-toggle").click();
    const current = popover.locator('[data-testid="model-row"][data-provider="muse"][data-model="muse-spark-1.3-contributor"]:not([aria-disabled="true"])');
    await expect(current).toBeVisible({ timeout: 5_000 });
    await current.click();

    await textarea.click();
    await textarea.fill("ping");
    await textarea.press("Enter");

    await expect.poll(() => !!capturedBody, { timeout: 15_000 }).toBe(true);
    expect(capturedBody.provider).toBe("muse");
    expect(capturedBody.model).toContain("muse-spark");
    // The stub answers for real through the stack: no route mock on the way back.
    await expect(page.getByTestId("chat-message").filter({ hasText: "e2e-muse-ok" }).first())
      .toBeVisible({ timeout: 30_000 });
    await didascalia(page, "Il topic risponde sul modello muse");
    await beat(page);
  });
});
