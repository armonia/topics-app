import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
test.use({ video: VIDEO_ON });

/**
 * THE RESERVE ASKS BEFORE IT IS SPENT (15/11).
 *
 * With every other subscription out, the account engine stops the turn on
 * the last one and answers `reserve_confirmation_required` instead of falling
 * to the paid keys (which answered "credit balance is too low" and killed
 * every turn with 5% of the week still there). The chat offers a button to
 * continue on the reserve: the yes goes to the engine BEFORE the resend, because a
 * resend without it would hit the same wall. Any other error does not offer
 * that button: only the reserve stop does.
 *
 * @covers CHAT-REL-07
 */
test.describe.serial("Lo stop della riserva", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;
  let hub: FakeHub | null = null;

  const STOP = '⚠️ API 400: {"type":"error","error":{"type":"reserve_confirmation_required","message":"Only the reserve is left: reserve@example.test (5% left). Every other account is out until 09:00."}}';
  const CREDIT_ERROR = '⚠️ API 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    topicName = "Riserva " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    await hub?.close();
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("un errore qualsiasi non offre la riserva", async ({ page, request }) => {
    await seedMessage(request, { sessionKey, role: "user", content: "prima domanda" });
    await seedMessage(request, { sessionKey, role: "assistant", content: CREDIT_ERROR, blocks: [{ kind: "error", text: CREDIT_ERROR }] });
    await goToApp(page);
    await openTopic(page, topicName);
    await expect(page.locator('[data-testid="message-retry"]').last()).toBeVisible();
    await expect(page.locator('[data-testid="message-reserve-continue"]')).toHaveCount(0);
  });

  test("«Continua sulla riserva» manda il sì al motore e poi rimanda il messaggio", async ({ page, request }) => {
    await seedMessage(request, { sessionKey, role: "user", content: "specifiche del prodotto" });
    await seedMessage(request, { sessionKey, role: "assistant", content: STOP, blocks: [{ kind: "error", text: STOP }] });
    await goToApp(page);
    await openTopic(page, topicName);

    const verdict = page.locator('[data-testid="turn-error"]').last();
    await expect(verdict).toContainText("Only the reserve is left");
    const continueButton = page.locator('[data-testid="message-reserve-continue"]');
    await expect(continueButton).toBeVisible();
    await expect(continueButton).toHaveText("Continua sulla riserva");
    const usersBefore = await page.locator('[data-testid="message-content-user"]').count();
    await page.locator('[data-testid="message-content-assistant"]').last().locator("xpath=ancestor::*[3]").screenshot({ path: test.info().outputPath("riserva-bottone.png") });

    await continueButton.click();

    // The yes reached the engine, once, with confirm: true.
    await expect.poll(() => hub!.posts.filter((p) => p.path === "reserve-confirm").length, { timeout: 10_000 }).toBe(1);
    expect(hub!.posts.find((p) => p.path === "reserve-confirm")?.confirm).toBe(true);
    // And after the yes the message went out again: a new user turn in the chat.
    await expect.poll(() => page.locator('[data-testid="message-content-user"]').count(), { timeout: 15_000 }).toBeGreaterThan(usersBefore);
    await expect(page.locator('[data-testid="message-content-user"]').last()).toContainText("specifiche del prodotto");
  });
});
