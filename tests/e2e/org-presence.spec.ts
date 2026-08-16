/**
 * La presence dell'organizzazione, VISTA.
 *
 * Il lavoro originale (05455772) aveva sei test sulla funzione pura e uno di
 * integrazione sulla rotta, e li ha passati tutti. Nessuno dei sette guardava
 * lo schermo: la funzione sapeva contare, la rotta sapeva rispondere, e se il
 * numero non fosse mai arrivato agli occhi di nessuno sarebbero rimasti verdi
 * lo stesso. È il modo più comune in cui una feature risulta «fatta» e non c'è.
 *
 * Qui si guarda il pixel: la riga esiste, mostra il numero giusto, e sparisce
 * quando non c'è nessuno.
 */
import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";

const SHOTS = "test-results/presence";

/** Un membro come lo manda la rotta: millisecondi grezzi, non un booleano. */
function membro(id: string, name: string, lastSeenAt: number | null) {
  return { id, name, email: `${id}@example.test`, role: "member", lastSeenAt };
}

/**
 * L'anagrafica minima perché la riga si disegni.
 *
 * `/api/auth/session` deve dire `paired`: la riga intera è dietro
 * `session.status !== 'paired' → return null`, quindi su un'installazione senza
 * accoppiamento la presence non c'è a prescindere dai membri.
 */
async function stubIdentita(page: Page, membri: ReturnType<typeof membro>[], ioId = "io") {
  // La forma e' quella VERA della rotta (`refreshSession` in lib/auth/session.ts):
  // `paired` + `as` + `name`, non uno `status` gia' masticato. Uno stub inventato
  // avrebbe lasciato la riga smontata e il rosso avrebbe accusato la presence
  // invece del finto server.
  await page.route("**/api/auth/session", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                             role: "owner", personId: ioId }) }));
  await page.route("**/api/auth/devices", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ devices: [{ connected: true, revokedAt: null }] }) }));
  await page.route("**/api/auth/orgs", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ orgs: [{ id: "org1", name: "Org", installation: true }] }) }));
  // La rubrica: e' da QUI che il client sa chi sei (`usePersonaCorrente`), non
  // dalla sessione. Sono due fetch diverse, ed e' precisamente la ragione per
  // cui `presentiOra` deve saper tacere quando l'identita' non c'e' ancora.
  await page.route("**/api/people", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ people: [{ id: ioId, displayName: "Io", isMe: true }] }) }));
  await page.route("**/api/auth/orgs/*/members", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ members: membri }) }));
}

test.describe("presence dell'organizzazione, a schermo", () => {
  test("PRESENCE-01: due colleghi visti ora diventano il numero 2", async ({ page }) => {
    const ora = Date.now();
    await stubIdentita(page, [
      membro("io", "Io", ora),          // te stesso non conti
      membro("a", "Anna", ora - 30_000),
      membro("b", "Bruno", ora - 60_000),
      membro("c", "Carla", ora - 3_600_000), // un'ora fa: oltre la soglia
    ]);
    await page.goto("/");

    const p = page.getByTestId("org-presence");
    await expect(p).toBeVisible({ timeout: 20000 });
    await expect(p).toHaveText("2");
    await page.screenshot({ path: join(SHOTS, "presence-due.png") });
  });

  test("PRESENCE-02: da solo, la riga NON c'è", async ({ page }) => {
    // «0 online» è rumore che si impara a saltare, e una riga che dice sempre
    // qualcosa smette di essere guardata. L'assenza è la scelta, quindi va
    // difesa: è esattamente ciò che una regressione romperebbe per prima.
    await stubIdentita(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    await expect(page.getByTestId("device-identity")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-presence")).toHaveCount(0);
  });

  test("PRESENCE-03: un membro senza dispositivi vivi vale null, non il 1970", async ({ page }) => {
    // `lastSeenAt: null` è «non si sa», e ordinando per ultimo-visto uno zero
    // finirebbe in fondo insieme a chi c'è stato davvero. Se il client leggesse
    // null come 0 il conteggio non cambierebbe, ma un `null` trattato come data
    // sì: qui si verifica che non entri nel conto.
    await stubIdentita(page, [
      membro("io", "Io", Date.now()),
      membro("a", "Anna", null),
    ]);
    await page.goto("/");
    await expect(page.getByTestId("device-identity")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-presence")).toHaveCount(0);
  });
});
