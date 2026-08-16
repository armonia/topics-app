/**
 * «Chi sei» e «che ferri hai» sono due voci, e i due ingressi ci arrivano.
 *
 * Il lavoro originale (6134a25e) separava una voce sola — `SectionId` diceva
 * `devices`, l'etichetta diceva «Profile» — in due. È stato verificato
 * guardando la colonna a occhio, e basta: nessun test lo teneva. È lo stesso
 * schema che ha lasciato passare il bug della presence (e290c513), dove sette
 * test verdi non guardavano mai lo schermo.
 *
 * Qui si difendono le tre cose che una regressione romperebbe per prime: le due
 * voci esistono, mostrano contenuti DIVERSI, e i due deep-link portano ciascuno
 * al suo — che è precisamente ciò che prima era rotto, con `onOpenDevices` e
 * `onOpenProfile` che puntavano entrambi a `devices`.
 *
 * La voce attiva si legge da `aria-current="page"`, che il pannello già mette:
 * un `data-testid` aggiunto apposta per il test misurerebbe il test.
 */
import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";

const SHOTS = "test-results/settings";

/**
 * ⌘, apre le Preferenze: la stessa porta che usa `escape-modal-guard`.
 *
 * L'ATTESA PRIMA DEL TASTO non e' cerimonia. La scorciatoia la ascolta un
 * effetto dell'app montata, quindi una pressione mandata a documento appena
 * caricato si perde nel vuoto e il test diventa flaky (visto: primo tentativo
 * rosso, ritentativo verde). Si aspetta un pezzo di app VIVO, non un tempo
 * fisso, e il tasto si ripete finche' il pannello non c'e': cosi' la prova
 * dipende dall'app pronta e non da quanto e' carica la macchina.
 */
async function apriImpostazioni(page: Page) {
  await expect(page.getByTestId("device-identity")).toBeVisible({ timeout: 20000 });
  const pannello = page.locator('[data-testid="settings-panel"]');
  await expect(async () => {
    await page.keyboard.press("Meta+Comma");
    await expect(pannello).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  return pannello;
}

test.describe("Impostazioni: profilo e dispositivi sono due domande", () => {
  test("SETTINGS-01: Profile e Devices sono due voci distinte", async ({ page }) => {
    await page.goto("/");
    const pannello = await apriImpostazioni(page);
    await expect(pannello.getByRole("button", { name: "Profile", exact: true })).toBeVisible();
    await expect(pannello.getByRole("button", { name: "Devices", exact: true })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "settings-due-voci.png") });
  });

  test("SETTINGS-02: le due voci mostrano contenuti diversi", async ({ page }) => {
    // Due etichette sopra lo STESSO pannello sarebbero il difetto di prima con
    // un nome in più: la prova che sono separate è ciò che c'è dentro.
    await page.goto("/");
    const pannello = await apriImpostazioni(page);

    await pannello.getByRole("button", { name: "Profile", exact: true }).click();
    const profilo = await pannello.innerText();

    await pannello.getByRole("button", { name: "Devices", exact: true }).click();
    const dispositivi = await pannello.innerText();

    expect(profilo).not.toBe(dispositivi);
  });

  test("SETTINGS-03: la riga d'identità apre i DISPOSITIVI, non il profilo", async ({ page }) => {
    // È IL bug originale: `onOpenDevices` (riga d'identità in fondo alla
    // sidebar) e `onOpenProfile` (menu Topics) puntavano ENTRAMBI a `devices`.
    // Due porte diverse che aprivano la stessa stanza, e i loro nomi dicevano
    // già che era sbagliato. Questa metà è quella raggiungibile senza un
    // account configurato, quindi è quella che si può difendere qui.
    await page.route("**/api/auth/session", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                               role: "owner", personId: "io" }) }));
    await page.goto("/");

    const identita = page.getByTestId("device-identity");
    await expect(identita).toBeVisible({ timeout: 20000 });
    await identita.click();

    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 20000 });
    await expect(
      pannello.getByRole("button", { name: "Devices", exact: true }),
      "la riga d'identità deve aprire i DISPOSITIVI",
    ).toHaveAttribute("aria-current", "page");
    await expect(
      pannello.getByRole("button", { name: "Profile", exact: true }),
      "…e NON il profilo: erano lo stesso posto, ed è il difetto che è stato corretto",
    ).not.toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: join(SHOTS, "settings-deeplink-devices.png") });
  });
});
