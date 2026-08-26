import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: si riparte dalla baseline del globalSetup.
hermetic(test);

/**
 * Scegliere l'autonomia su una chat NUOVA (bozza).
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * Una chat nuova non ha ancora una riga sul server: il pane porta un topic
 * sintetico con id `draft:<uuid>` (`state/pane/adapters/paneConfig.ts`). Il
 * selettore di autonomia però faceva `PATCH /api/topics/<id>` incondizionata —
 * quindi su una bozza colpiva un id che non esiste, e l'utente vedeva
 * «Non sono riuscito a cambiare l'autonomia» a ogni tentativo di scegliere
 * PRIMA di scrivere il primo messaggio. Nel log di prod si legge testualmente
 * `PATCH /api/topics/draft:a7bfeee2-8313-4dac-8819-10db37c627bc`.
 *
 * Era l'unico dei quattro selettori del composer senza il trattamento delle
 * bozze: provider/model, Fast Mode ed effort persistono la scelta in
 * localStorage e la migrano al topic vero alla promozione. L'autonomia no.
 *
 * ── Cosa blinda questa spec ─────────────────────────────────────────────────
 * Che su una bozza la scelta (a) non produca un errore, (b) resti selezionata.
 * Sono le due cose che l'utente vede; la migrazione alla promozione è coperta
 * dal typecheck del ramo `wasDraft && isNowReal` in ChatPane, dove vive già la
 * stessa migrazione per gli altri tre.
 *
 * @covers CHAT-DEF-04
 */
test.describe.serial("Composer — autonomia su una chat nuova", () => {
  test("scegliere «Libero» su una bozza non dà errore e resta scelto", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-DEF-04" });
    await goToApp(page);
    await page.keyboard.press("Escape");

    // Il menu «+» per testid, non per ruolo/testo: è stato unificato in una
    // lista sola con le lettere-scorciatoia, e agganciarlo dal nome visibile
    // rompe a ogni ritocco di copy (vedi add-menu.spec.ts).
    await page.getByTestId("pane-add-menu-trigger").first().click();
    const menu = page.getByTestId("pane-add-menu");
    await expect(menu).toBeVisible({ timeout: 5000 });
    await menu.getByTestId("pane-add-menu-new-chat").click();

    // La bozza è viva: il composer della chat nuova è a schermo.
    const picker = page.getByTestId("composer-autonomy").last();
    await expect(picker).toBeVisible({ timeout: 10000 });

    // Nessuna PATCH deve partire verso un id `draft:` — è LA causa del guasto,
    // quindi la si osserva direttamente invece di dedurla dall'assenza di toast.
    const draftPatches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && /\/api\/topics\/draft(%3A|:)/.test(req.url())) {
        draftPatches.push(req.url());
      }
    });

    await picker.click();
    await expect(page.getByTestId("composer-autonomy-panel").last()).toBeVisible({ timeout: 5000 });
    await page.getByTestId("composer-autonomy-yolo").last().click();

    // (a) nessun errore. Il toast è la faccia del difetto.
    await expect(page.getByText(/Non sono riuscito a cambiare l'autonomia/)).toHaveCount(0);
    expect(draftPatches, "nessuna PATCH verso un id draft:").toEqual([]);

    // (b) la scelta RESTA. Il trigger porta `data-level` con il livello attivo:
    // prima del fix restava sul default, perché il valore veniva letto da
    // `topic.autonomyLevel` — che su una bozza non esiste — e la PATCH fallita
    // non lo cambiava.
    await expect(picker).toHaveAttribute("data-level", "yolo", { timeout: 5000 });
  });
});
