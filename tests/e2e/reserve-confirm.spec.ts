import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";

hermetic(test);
test.use({ video: "on" });

/**
 * LA RISERVA CHIEDE PRIMA DI ESSERE SPESA (15/11).
 *
 * Con gli altri abbonamenti finiti, il motore degli account ferma il turno
 * sull'ultimo e risponde `reserve_confirmation_required` invece di cadere
 * sulle chiavi a pagamento (che rispondevano «credit balance is too low» e
 * uccidevano ogni turno col 5% della settimana ancora lì). La chat offre
 * «Continua sulla riserva»: il sì va al motore PRIMA del rinvio, perché un
 * rinvio senza il sì sbatterebbe sullo stesso muro. Un errore qualsiasi non
 * offre quel bottone: solo lo stop della riserva.
 *
 * @covers CHAT-REL-07
 */
test.describe.serial("Lo stop della riserva", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;
  let hub: FakeHub | null = null;

  const STOP = '⚠️ API 400: {"type":"error","error":{"type":"reserve_confirmation_required","message":"Only the reserve is left: reserve@example.test (5% left). Every other account is out until 09:00."}}';
  const CREDITO = '⚠️ API 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

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
    await seedMessage(request, { sessionKey, role: "assistant", content: CREDITO, blocks: [{ kind: "error", text: CREDITO }] });
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

    const verdetto = page.locator('[data-testid="turn-error"]').last();
    await expect(verdetto).toContainText("Only the reserve is left");
    const continua = page.locator('[data-testid="message-reserve-continue"]');
    await expect(continua).toBeVisible();
    await expect(continua).toHaveText("Continua sulla riserva");
    const utentiPrima = await page.locator('[data-testid="message-content-user"]').count();
    await page.locator('[data-testid="message-content-assistant"]').last().locator("xpath=ancestor::*[3]").screenshot({ path: test.info().outputPath("riserva-bottone.png") });

    await continua.click();

    // Il sì è arrivato al motore, una volta, con confirm: true.
    await expect.poll(() => hub!.posts.filter((p) => p.path === "reserve-confirm").length, { timeout: 10_000 }).toBe(1);
    expect(hub!.posts.find((p) => p.path === "reserve-confirm")?.confirm).toBe(true);
    // E dopo il sì il messaggio è ripartito: un nuovo turno dell'utente in chat.
    await expect.poll(() => page.locator('[data-testid="message-content-user"]').count(), { timeout: 15_000 }).toBeGreaterThan(utentiPrima);
    await expect(page.locator('[data-testid="message-content-user"]').last()).toContainText("specifiche del prodotto");
  });
});
