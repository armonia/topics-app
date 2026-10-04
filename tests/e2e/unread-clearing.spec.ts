/**
 * The badge of a topic in the sidebar: it appears while the topic is LIT and
 * not focused (a turn finished and not seen: since notifications-redesign an
 * unread count alone, a system message, paints nothing, TAB-BADGE-01
 * modified), it clears when the topic is opened, and it SURVIVES a selection
 * that only passed through: below the dwell threshold nothing was seen. The
 * turns are real, on the chat route with a fake CLI.
 *
 * @covers TOPIC-02
 */
import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { runChatTurn, setAwake, stubBannersAndWindow } from "./helpers/attention";
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
  let removeCli: (() => void) | null = null;

  test.beforeAll(async ({ request }) => {
    removeCli = installSlowTurnCli();
    topicName = `unread-test-${Date.now()}`;
    const topic = await createTopic(request, topicName, { provider: "claude-code" });
    topicId = topic.id;
    otherName = `unread-altrove-${Date.now()}`;
    const other = await createTopic(request, otherName, { provider: "claude-code" });
    otherId = other.id;
  });

  test.afterAll(async ({ request }) => {
    removeCli?.();
    if (topicId) await deleteTopic(request, topicId);
    if (otherId) await deleteTopic(request, otherId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId, otherId]);
  });

  const badgeOf = (page: import("@playwright/test").Page, name: string) =>
    page.getByRole("treeitem", { name: new RegExp(name) }).locator("[data-notification-count]");

  test("the badge appears when a turn finishes on an unfocused topic, and a system message alone paints none", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-01" });
    await stubBannersAndWindow(page);
    await goToApp(page);
    await expect(page.getByRole("treeitem", { name: new RegExp(topicName) })).toBeVisible({ timeout: 10000 });

    // A system message raises the unread count, and lights nothing.
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, { data: { content: "Test unread message" }, ignoreHTTPSErrors: true });
    // The sentinel: the other chat's turn, finished after it, lights its row,
    // so the message before it has been applied when the check below runs.
    await runChatTurn(request, otherId, "sentinel");
    await expect(badgeOf(page, otherName)).toBeVisible({ timeout: 10000 });
    await expect(badgeOf(page, topicName)).toHaveCount(0);

    // A turn that finishes while nobody looks: the badge.
    await runChatTurn(request, topicId, "finish");
    await expect(badgeOf(page, topicName)).toBeVisible({ timeout: 10000 });
  });

  test("unread badge clears when topic is clicked", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-01" });
    await stubBannersAndWindow(page);
    await goToApp(page);
    await runChatTurn(request, topicId, "finish again");
    await expect(badgeOf(page, topicName)).toBeVisible({ timeout: 10000 });

    // Open the topic with the window awake: the seen threshold fires.
    await setAwake(page, true);
    await openTopic(page, new RegExp(topicName));
    await expect(badgeOf(page, topicName)).toHaveCount(0, { timeout: SEEN_DWELL_MS + 5000 });
  });

  // La soglia, dal lato che conta: selezionare NON è guardare.
  test("il badge SOPRAVVIVE a una selezione di passaggio (soglia di 'visto')", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-BADGE-01" });
    await stubBannersAndWindow(page, { awake: true });
    await goToApp(page);

    // Porta il fuoco ALTROVE, così il turno seguente non nasce visto.
    await openTopic(page, new RegExp(otherName));
    await runChatTurn(request, topicId, "da non leggere");

    const target = page.getByRole("treeitem", { name: new RegExp(topicName) });
    const badge = target.locator("[data-notification-count]");
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
