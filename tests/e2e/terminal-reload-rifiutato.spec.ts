/**
 * @covers RESTART-SAY-01
 *
 * UN RIAVVIO RIFIUTATO NON E' UN'ATTESA.
 *
 * Segnalato: «riavvio sessione non va o si blocca». Non era un blocco: era un
 * silenzio che gli somiglia. Il gesto «Ricarica» su una tab terminale mandava la
 * POST e ne buttava via il risultato — nessun controllo su `ok`, e un
 * `.catch(() => {})` che ingoiava tutto. Il server pero' rifiuta in tre modi
 * (409 se un reload e' gia' in corso, 404 se la sessione non c'e', 500 se lo
 * spawn fallisce: `server/routes/terminal.ts`), e in tutti e tre l'interfaccia
 * mostrava «Riavvio…» per QUINDICI SECONDI e poi lo toglieva senza dire niente.
 *
 * Il tetto dei 15s e' la rete di sicurezza per la riconnessione che non arriva,
 * non il modo di sapere che e' andata male. Qui si prova la differenza: su un
 * rifiuto la pane torna utilizzabile SUBITO, e il motivo si legge.
 *
 * Il rifiuto si INIETTA (`page.route`) invece di provocarlo: un 409 vero
 * richiederebbe due reload in corsa, che e' una gara e non una prova.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("Ricarica di una tab terminale · il rifiuto si vede", () => {
  test("un rifiuto del server toglie SUBITO «Riavvio…» e dice il motivo", async ({ page }) => {
    const MOTIVO = "Reload already in progress for this session";

    await page.route("**/api/terminal/sessions/*/reload", (route) =>
      route.fulfill({ status: 409, contentType: "text/plain", body: MOTIVO }),
    );

    await goToApp(page);

    // Una tab terminale qualunque: il gesto vive nel suo menu contestuale.
    const tab = page.locator('[data-pane-id^="terminal:"]').first();
    await expect(tab, "serve una tab terminale su cui provare il gesto").toBeVisible({ timeout: 30_000 });
    await tab.click({ button: "right" });

    const ricarica = page.getByRole("button", { name: /Ricarica/ });
    await expect(ricarica).toBeVisible({ timeout: 10_000 });
    await ricarica.click();

    // IL PUNTO. Il tetto e' 3 secondi, cioe' MOLTO sotto i 15 della rete di
    // sicurezza: se questo passasse aspettando quella, non proverebbe niente.
    await expect(
      page.getByTestId("terminal-reloading-overlay"),
      "«Riavvio…» e' rimasto su un riavvio che il server ha rifiutato",
    ).toHaveCount(0, { timeout: 3_000 });

    await expect(
      page.getByText(MOTIVO),
      "il rifiuto e' stato ingoiato: chi guarda non sa perche' non e' successo niente",
    ).toBeVisible({ timeout: 5_000 });
  });
});
