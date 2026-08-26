import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * `/compact` deve essere RAGGIUNGIBILE.
 *
 * La compattazione esisteva già — l'app la esegue e ne disegna pure l'esito (i
 * divider «context compacted», vedi partitionMarkers.ts) — ma l'unico modo di
 * chiederla era il bottone «Compatta adesso» dentro l'avviso del contesto: compare
 * solo sopra soglia, e sparisce appena lo si chiude (`dismissed[reason]` ricorda
 * il livello). A contesto tranquillo non esisteva nessun modo di lanciarla, e
 * `/help` non la nominava nemmeno: chi non aveva mai visto l'avviso non poteva
 * sapere che ci fosse.
 *
 * Questo test guarda la scoperta, non il risultato: che la compattazione FACCIA
 * il suo lavoro dipende dalla CLI a valle (il client non intercetta `/compact`,
 * lo lascia passare come fa il bottone). Quello che qui si pretende è che il
 * comando si trovi — perché è esattamente la parte che mancava.
 *
 * @covers CMD-06
 */
test.describe("Chat /compact — il comando si trova", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `compact-cmd-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ page, request }) => {
    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
  });

  test("digitando `/comp` il menu propone /compact", async ({ page, chatPage }) => {
    const input = chatPage.messageInput;
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.click();
    await input.fill("/comp");

    // Il menu filtra su prefisso (`allSlashCommands.filter(startsWith)`), quindi
    // "/comp" deve bastare: se `/compact` non è nel registro, qui non c'è nulla.
    await expect(page.getByText("/compact", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("l'anello del contesto offre «Compatta»", async ({ page, chatPage }) => {
    // La seconda superficie permanente: chi sta guardando quanto contesto sta
    // consumando deve poterlo compattare da li', senza ricordarsi un comando.
    await expect(chatPage.messageInput).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /context/i }).first().click();
    const popover = page.locator('[data-popover="context-inspector"]');
    await expect(popover).toBeVisible({ timeout: 15_000 });
    // Il riquadro compare SUBITO ma vuoto: l'Inspector e' `lazy()`, e finche' il
    // suo chunk non arriva dentro c'e' solo lo spinner. Si aspetta il titolo,
    // che e' il primo pezzo di contenuto vero — altrimenti si cerca un bottone
    // dentro un guscio ancora vuoto e il test fallisce per pura tempistica.
    await expect(popover.getByTestId("context-inspector")).toBeVisible({ timeout: 20_000 });
    // «Compatta» sta nell'INTESTAZIONE, ora: e' l'unica azione del pannello,
    // quindi non si cerca a meta' elenco.
    await expect(popover.getByRole("button", { name: /^(Compatta|Compact)$/ })).toBeVisible({ timeout: 10_000 });
  });

  test("`/help` elenca /compact", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-06" });
    const input = chatPage.messageInput;
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.click();
    await input.fill("/help");
    // Escape PRIMA di Enter: digitando `/` si apre il menu comandi, e con il
    // menu aperto Enter SELEZIONA la voce evidenziata invece di inviare il
    // messaggio (handleKeyDown intercetta Tab/Enter quando
    // `showSlashMenu && filteredSlashCommands.length > 0`). Senza questo, il
    // test non stava provando `/help`: stava scegliendo una voce dal menu.
    await input.press("Escape");
    await input.press("Enter");

    // `/help` è intercettato dal client e risponde in un banner di risultato:
    // se `/compact` manca dall'elenco, chi legge l'aiuto continua a non sapere
    // che la compattazione si può chiedere.
    await expect(page.getByText(/\/compact/).first()).toBeVisible({ timeout: 15_000 });
  });
});
