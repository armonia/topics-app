/**
 * The unread badge of a topic in the sidebar: it appears while the topic is not
 * focused, it clears when the topic is opened, and it SURVIVES a selection that only
 * passed through — below the dwell threshold nothing was actually seen.
 *
 * @covers TOPIC-02
 */
import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/** La soglia di "visto" del client (state/signals.ts::SEEN_DWELL_MS). Ricopiata
 *  qui perché una spec E2E non importa dal bundle del client; il test sotto
 *  fallisce se le due divergono, che è la guardia. */
const SEEN_DWELL_MS = 1200;

test.describe("Unread badge clearing", () => {
  let topicId: string;
  let topicName: string;
  // Una SECONDA topic dove spostare il fuoco: serve a provare il clic di
  // passaggio, che è "vai su A e subito via" — senza un altrove, A resta a fuoco
  // e la soglia scatterebbe come deve.
  let otherId: string;
  let otherName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `unread-test-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    otherName = `unread-altrove-${Date.now()}`;
    const other = await createTopic(request, otherName);
    otherId = other.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
    if (otherId) await deleteTopic(request, otherId);
  });

  // Il badge di non-letto si conta sul tab APERTO del topic: il pane-store è
  // condiviso da tutta la suite seriale, quindi qui riportiamo lo stato al solo
  // tab seminato da createTopic — né più (pane altrui) né meno (il tab serve).
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId, otherId]);
  });

  test("unread badge appears when message arrives for unfocused topic", async ({ page, request }) => {
    await goToApp(page);

    // Send a message to the topic via API (simulating an external message)
    await request.post(`${BASE}/api/topics/${topicId}/read`, {
      ignoreHTTPSErrors: true,
    });

    // Inject an unread count by posting a system message while topic is not focused
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: "Test unread message" },
      ignoreHTTPSErrors: true,
    });

    // Wait for unread badge to appear on the topic in the sidebar
    const topicItem = page.getByRole("treeitem", { name: new RegExp(topicName) });
    await expect(topicItem).toBeVisible({ timeout: 10000 });

    // Check for unread badge (a span with bg-primary class inside the topic item)
    const badge = topicItem.locator("span.bg-primary");
    await expect(badge).toBeVisible({ timeout: 10000 });
  });

  test("unread badge clears when topic is clicked", async ({ page }) => {
    await goToApp(page);

    // Open the topic. Il markRead NON parte più a questo istante: parte quando la
    // soglia di "visto" scatta (SEEN_DWELL_MS di permanenza a finestra sveglia).
    await openTopic(page, new RegExp(topicName));

    // La topic RESTA a fuoco, quindi la soglia scatta: l'asserzione qui sotto
    // riprova finché il badge sparisce, e il margine copre la soglia + la POST.
    const topicItem = page.getByRole("treeitem", { name: new RegExp(topicName) });
    const badge = topicItem.locator("span.bg-primary");
    await expect(badge).not.toBeVisible({ timeout: SEEN_DWELL_MS + 5000 });
  });

  // La soglia, dal lato che conta: selezionare NON è guardare.
  //
  // Prima questo test non poteva esistere, perché il comportamento era l'opposto:
  // `clearUnreadFor` era agganciato al frame `focus` uscente, quindi un clic di
  // passaggio — mentre cerchi un'altra tab — azzerava l'unread di una chat che non
  // avevi letto. È il sintomo "la tab non resta blu finché non la visualizzo".
  test("il badge SOPRAVVIVE a una selezione di passaggio (soglia di 'visto')", async ({ page, request }) => {
    await goToApp(page);

    // Porta il fuoco ALTROVE, così il messaggio seguente conta come non-letto
    // (il server sopprime l'incremento per la topic a fuoco).
    await openTopic(page, new RegExp(otherName));
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: "messaggio da non leggere" },
      ignoreHTTPSErrors: true,
    });

    const target = page.getByRole("treeitem", { name: new RegExp(topicName) });
    const badge = target.locator("span.bg-primary");
    await expect(badge).toBeVisible({ timeout: 10000 });

    // Clic di passaggio: entra e esce ben sotto la soglia. Due click consecutivi
    // costano ~50-200 ms, cioè un ordine di grandezza meno di SEEN_DWELL_MS.
    await target.click();
    await page.getByRole("treeitem", { name: new RegExp(otherName) }).click();

    // Qui il tempo DEVE passare: l'asserzione è su una soglia temporale, e un
    // `expect` che riprova proverebbe solo che il badge c'è ADESSO — non che sia
    // sopravvissuto alla finestra in cui prima veniva azzerato. Questa è l'unica
    // ragione per cui una pausa è corretta in questa suite.
    await page.waitForTimeout(SEEN_DWELL_MS + 800);

    // Il badge è ancora lì: quella chat non è stata guardata.
    await expect(badge).toBeVisible();
  });
});
