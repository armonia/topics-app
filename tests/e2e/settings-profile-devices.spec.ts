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
import { hermetic } from "./fixtures/hermetic";

// Il confine fra questo file e il precedente: senza, questa spec eredita
// cio' che i test prima di lei hanno lasciato nel DB condiviso.
hermetic(test);

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
  await expect(page.getByTestId("identity-row-me")).toBeVisible({ timeout: 20000 });
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
    await expect(pannello.getByRole("button", { name: "Profilo", exact: true })).toBeVisible();
    await expect(pannello.getByRole("button", { name: "Dispositivi", exact: true })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "settings-due-voci.png") });
  });

  test("SETTINGS-02: le due voci mostrano contenuti diversi", async ({ page }) => {
    // Due etichette sopra lo STESSO pannello sarebbero il difetto di prima con
    // un nome in più: la prova che sono separate è ciò che c'è dentro.
    await page.goto("/");
    const pannello = await apriImpostazioni(page);

    await pannello.getByRole("button", { name: "Profilo", exact: true }).click();
    const profilo = await pannello.innerText();

    await pannello.getByRole("button", { name: "Dispositivi", exact: true }).click();
    const dispositivi = await pannello.innerText();

    expect(profilo).not.toBe(dispositivi);
  });

  test("SETTINGS-03: il chip dei dispositivi apre i DISPOSITIVI, non il profilo", async ({ page }) => {
    // È IL bug originale: `onOpenDevices` (riga d'identità in fondo alla
    // sidebar) e `onOpenProfile` (menu Topics) puntavano ENTRAMBI a `devices`.
    // Due porte diverse che aprivano la stessa stanza.
    //
    // AGGIORNAMENTO: adesso la riga dell'identità ha DUE porte, perché aveva due
    // soggetti. Il nome e la faccia aprono il tuo PROFILO (è la riga che parla
    // di te), il chip col conteggio dei ferri apre i DISPOSITIVI. La cosa da
    // difendere resta la stessa: i dispositivi hanno una porta propria e non
    // vengono inghiottiti dal profilo.
    await page.route("**/api/auth/session", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                               role: "owner", personId: "io" }) }));
    await page.route("**/api/auth/devices", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ devices: [{ connected: true, revokedAt: null }] }) }));
    await page.goto("/");

    const ferri = page.getByTestId("identity-me-devices");
    await expect(ferri).toBeVisible({ timeout: 20000 });
    await ferri.click();

    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 20000 });
    await expect(
      pannello.getByRole("button", { name: "Dispositivi", exact: true }),
      "il chip dei ferri deve aprire i DISPOSITIVI",
    ).toHaveAttribute("aria-current", "page");
    await expect(
      pannello.getByRole("button", { name: "Profilo", exact: true }),
      "…e NON il profilo: sono due domande diverse, e ognuna ha la sua porta",
    ).not.toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: join(SHOTS, "settings-deeplink-devices.png") });
  });

  test("SETTINGS-04: il nome nella riga d'identità apre il pane Profilo", async ({ page }) => {
    // L'altra metà della stessa decisione: la riga parla di te, quindi il suo
    // bersaglio grande porta dove si guarda chi sei. Prima non ci portava
    // niente, e il profilo si trovava solo dal menu «Topics».
    await page.route("**/api/auth/session", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                               role: "owner", personId: "io" }) }));
    await page.goto("/");

    const io = page.getByTestId("identity-me-profile");
    await expect(io).toBeVisible({ timeout: 20000 });
    await io.click();

    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("settings-page-profile")).toBeVisible();
  });
});
