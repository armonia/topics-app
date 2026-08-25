import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: si riparte dalla baseline del globalSetup.
hermetic(test);

/**
 * Il modello scelto nel composer RESTA — sulla chat e su quella dopo.
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * Una chat NUOVA non ha riga sul server: porta un topic sintetico `draft:<uuid>`
 * (`state/pane/adapters/paneConfig.ts`). In ChatPane l'effetto che rilegge il
 * provider/modello dal topic ripartiva anche sulle bozze e ci trovava, per forza,
 * niente: rimetteva `null`, cioè il default dell'app, sotto le dita di chi il
 * modello l'aveva appena scelto. E ripartiva DA SOLO, senza cambio di chat,
 * perché fra le sue dipendenze c'è `onUpdateTopic`, che per le bozze il gruppo
 * di chat ricrea a ogni render (`isDraft ? async () => null : onUpdateTopic`,
 * StandaloneChatGroup).
 *
 * ── Cosa blinda questa spec ─────────────────────────────────────────────────
 * (a) sulla chat nuova la scelta resta anche dopo che il gruppo si ridisegna;
 * (b) la chat nuova SUCCESSIVA parte gia' con quel modello.
 * Sono le due frasi della richiesta: «deve conservarsi per la chat e per le
 * chat nuove successive».
 *
 * @covers CHAT-DEF-04
 */
test.describe.serial("Composer — memoria del modello sulle chat nuove", () => {
  async function openNewChat(page: import("@playwright/test").Page) {
    await page.getByTestId("pane-add-menu-trigger").first().click();
    const menu = page.getByTestId("pane-add-menu");
    await expect(menu).toBeVisible({ timeout: 5000 });
    await menu.getByTestId("pane-add-menu-new-chat").click();
  }

  test("la scelta resta sulla bozza e la eredita la chat nuova dopo", async ({ page, request }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");

    await openNewChat(page);

    const picker = page.getByTestId("provider-model-picker").last();
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await picker.click();

    const popover = page.getByTestId("provider-model-popover");
    await expect(popover).toBeVisible({ timeout: 5000 });
    const rows = popover.locator("button[data-model]:not([disabled])");
    if (await rows.count() === 0) {
      test.skip(true, "Nessun provider pronto con modelli in questo ambiente");
    }
    // Una riga DIVERSA da quella gia' attiva, altrimenti «resta scelto» non
    // distingue la memoria dal default.
    const current = await picker.getAttribute("data-model");
    const target = rows.filter({ hasNot: page.locator(`[data-model="${current ?? "___"}"]`) });
    const row = (await target.count()) > 0 ? target.first() : rows.first();
    const chosen = await row.getAttribute("data-model");
    expect(chosen).toBeTruthy();
    await row.click();

    await expect(picker).toHaveAttribute("data-model", chosen!, { timeout: 5000 });

    // (a) La scelta sopravvive a un ridisegno del gruppo di chat. Ne basta uno
    // qualunque: un topic creato altrove arriva in WS, l'albero dei topic si
    // aggiorna, il gruppo si ridisegna — e con lui la funzione `onUpdateTopic`
    // che per le bozze è inline. È il caso di tutti i giorni (un altro agente
    // che lavora, la board che si muove), non un gesto di laboratorio.
    const noise = await createTopic(request, "Rumore " + Date.now());
    try {
      await expect(picker).toHaveAttribute("data-model", chosen!, { timeout: 5000 });
    } finally {
      await deleteTopic(request, noise.id);
    }

    // (b) La chat nuova successiva parte gia' con quel modello.
    await openNewChat(page);
    const nextPicker = page.getByTestId("provider-model-picker").last();
    await expect(nextPicker).toBeVisible({ timeout: 15_000 });
    await expect(nextPicker).toHaveAttribute("data-model", chosen!, { timeout: 5000 });
  });
});
