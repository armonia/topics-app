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
import { hermetic } from "./fixtures/hermetic";

// Il confine fra questo file e il precedente: senza, questa spec eredita
// cio' che i test prima di lei hanno lasciato nel DB condiviso.
hermetic(test);

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
async function stubIdentita(
  page: Page,
  membri: ReturnType<typeof membro>[],
  ioId = "io",
  rubrica: Array<{ id: string; displayName: string; isMe: boolean }> = [{ id: "io", displayName: "Io", isMe: true }],
) {
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
  // La rubrica: e' da QUI che il client sa chi sei (`useIdentityPresence`), non
  // dalla sessione. Sono due fetch diverse, ed e' precisamente la ragione per
  // cui `presentiOra` deve saper tacere quando l'identita' non c'e' ancora.
  await page.route("**/api/people", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ people: rubrica.map((p) => (p.isMe ? { ...p, id: ioId } : p)) }) }));
  await page.route("**/api/auth/orgs/*/members", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ members: membri }) }));
}

test.describe("presence dell'organizzazione, a schermo", () => {
  test("PRESENCE-01: due colleghi visti ora diventano il numero 2 sul chip dell'org", async ({ page }) => {
    const ora = Date.now();
    await stubIdentita(page, [
      membro("io", "Io", ora),          // te stesso non conti
      membro("a", "Anna", ora - 30_000),
      membro("b", "Bruno", ora - 60_000),
      membro("c", "Carla", ora - 3_600_000), // un'ora fa: oltre la soglia
    ]);
    await page.goto("/");

    const chip = page.getByTestId("org-chip");
    await expect(chip).toBeVisible({ timeout: 20000 });
    // La presenza sta DENTRO il chip del gruppo: con due organizzazioni un
    // conteggio unico non direbbe di quale gruppo sono.
    await expect(page.getByTestId("org-chip-online")).toHaveText("2");
    await page.screenshot({ path: join(SHOTS, "presence-due.png") });
  });

  test("PRESENCE-02: da solo, il chip resta ma il conteggio non c'è", async ({ page }) => {
    // «0 online» è rumore che si impara a saltare: al posto dello zero c'è un
    // pallino spento, che si vede senza leggerlo. Il chip invece resta, perché
    // è anche la porta della gestione delle organizzazioni.
    await stubIdentita(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    await expect(page.getByTestId("identity-row-me")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip-online")).toHaveCount(0);
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
    await expect(page.getByTestId("identity-row-me")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip-online")).toHaveCount(0);
  });

  test("PRESENCE-04: il chip dell'org apre il pannello, e il pannello la gestione", async ({ page }) => {
    // Il chip non salta più a una pagina: apre il suo pannello, che risponde
    // sul posto a «chi c'è in questo gruppo». La porta della gestione resta,
    // in fondo al pannello, per quando la domanda è davvero grossa.
    await stubIdentita(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    const chip = page.getByTestId("org-chip");
    await expect(chip).toBeVisible({ timeout: 20000 });
    await chip.click();
    await expect(page.getByTestId("org-panel")).toBeVisible();
    await page.getByTestId("org-open-manage").click();
    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("settings-page-organization")).toBeVisible();
  });

  test("PRESENCE-06: il pannello dell'org elenca ANCHE chi non è online", async ({ page }) => {
    // È metà del motivo per cui il pannello si apre: cercare qualcuno che in
    // questo momento non c'è. Il chip chiuso mostra i presenti, l'elenco no.
    const ora = Date.now();
    await stubIdentita(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
      membro("c", "Carla", ora - 3_600_000), // oltre la soglia: c'è, ma spenta
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna Rossi", isMe: false },
      { id: "c", displayName: "Carla Bianchi", isMe: false },
    ]);
    await page.goto("/");
    await page.getByTestId("org-chip").click();
    const panel = page.getByTestId("org-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("presence-person")).toHaveCount(2);
    await expect(panel.locator('[data-testid="presence-person"][data-online="true"]')).toHaveCount(1);
    await expect(panel).toContainText("Carla Bianchi");
  });

  test("PRESENCE-05: la riga degli amici mostra chi è online e apre gli amici", async ({ page }) => {
    const ora = Date.now();
    await stubIdentita(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna Rossi", isMe: false },
    ]);
    await page.goto("/");

    const amici = page.getByTestId("identity-row-friends");
    await expect(amici).toBeVisible({ timeout: 20000 });
    await expect(amici).toContainText("1");
    await page.getByTestId("identity-friends-chip").click();
    await expect(page.getByTestId("friends-panel")).toBeVisible();
    await page.getByTestId("friends-open-all").click();
    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("settings-page-friends")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "amici-online.png") });
  });

  test("PRESENCE-07: senza nessuno la riga amici resta e dice zero", async ({ page }) => {
    // Prima spariva. Una riga che esiste solo quando ha buone notizie lascia
    // senza risposta «ma gli amici dove stanno?» proprio a chi non ha ancora
    // nessuno, cioè l'unico che deve poterci entrare per cominciare.
    await stubIdentita(page, [membro("io", "Io", Date.now())], "io", [
      { id: "io", displayName: "Io", isMe: true },
    ]);
    await page.goto("/");
    const amici = page.getByTestId("identity-row-friends");
    await expect(amici).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("identity-friends-total")).toHaveText("0");
    // E il pannello spiega da dove arrivano le persone, invece di essere vuoto.
    await page.getByTestId("identity-friends-chip").click();
    await expect(page.getByTestId("friends-panel")).toContainText("organizzazioni");
  });
});
