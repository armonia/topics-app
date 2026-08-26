/**
 * LE SEZIONI APERTE SI ADATTANO AL CONTENUTO, col tetto di 1/N.
 *
 * «Fai in modo che gli accordion quando aperti si adattino al contenuto per
 * quanto riguarda l'altezza, fino a un massimo tipo di 1 / numero di accordion»
 * (Attilio, 10/08).
 *
 * Prima erano due numeri fissi — Git 200px, Processi 150 — quindi due file
 * modificati lasciavano ~160px di vuoto sotto e quaranta ne mostravano sei. Il
 * difetto non è visibile da una costante: il numero era coerente con sé stesso,
 * era il RAPPORTO col contenuto a non esistere. Quindi si misura il rettangolo.
  * @covers AUTOH-01
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { initGitRepo } from "./helpers/file-project";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

/** Il vecchio numero fisso di Git. Non è un valore atteso: è il valore da cui ci
 *  si deve essere staccati, e serve solo a rendere il rosso leggibile. */
const VECCHIA_ALTEZZA_PROCESSI = 150;

/* PERCHÉ IL SOGGETTO È «PROCESSI» E NON «GIT».
 *
 * Non perché Git sia rotto — ci ero arrivato, e mi sbagliavo. Git si apre
 * benissimo: quello che non funziona è il CLIC AL CENTRO, perché al centro
 * della sua intestazione c'è il controllo del ramo, che apre il proprio menu e
 * ferma la propagazione. Playwright, di default, clicca il centro. Lo
 * documentava già `project-sidebar-sections-resize.spec.ts`, che infatti la
 * apre premendo a `x: 24` — sull'etichetta.
 *
 * Il soggetto resta Processi per una ragione più noiosa e più solida: la sua
 * intestazione non ha controlli dentro, quindi il test non dipende da DOVE
 * atterra il clic. E la differenza si legge lì con la stessa chiarezza —
 * misurato, il suo pannello valeva ESATTAMENTE 150px, cioè il numero fisso, e
 * adesso vale quanto il suo contenuto. */

async function apri(page: import("@playwright/test").Page, request: import("@playwright/test").APIRequestContext, proj: string) {
  await resetPaneStore(request, []);
  await seedProjectPane(request, proj);
  await waitForPaneStoreQuiet(request);
  await page.setViewportSize({ width: 1400, height: 900 });
  await goToApp(page);
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
  const win = page.locator(`[data-testid="project-window"][data-project-path="${proj}"]`);
  await expect(win).toHaveCount(1, { timeout: 15000 });
  await expect(win.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 10000 });
  return win;
}

/**
 * Apre una sezione e si assicura che sia RIMASTA aperta.
 *
 * Un `if (!aperta) click()` letto una volta sola non basta, ed è una trappola
 * che questa suite ha già pagato altrove: lo stato arriva da `sessionStorage` e
 * si assesta dopo l'idratazione, quindi la lettura può precedere il valore vero
 * e il clic CHIUDE invece di aprire. Si rilegge e si riprova.
 */
async function garantisciAperta(t: import("@playwright/test").Locator, quante = 3) {
  for (let i = 0; i < quante; i++) {
    if ((await t.getAttribute("aria-expanded")) === "true") return;
    // L'intestazione si muove mentre le sezioni si assestano — aprire Git
    // sposta Processi — e un clic su un bersaglio in movimento non è
    // «azionabile»: il primo giro andava in timeout sul CLICK, non
    // sull'attributo. Si aspetta che sia ferma e visibile prima di premere.
    await t.scrollIntoViewIfNeeded();
    await t.click({ timeout: 8000 });
    // …e poi si aspetta la CONDIZIONE, non un tempo: 250ms fissi erano una
    // scommessa, e quando perdeva il giro dopo premeva di nuovo — richiudendo.
    try {
      await expect(t).toHaveAttribute("aria-expanded", "true", { timeout: 3000 });
      return;
    } catch { /* riprova */ }
  }
  await expect(t, "la sezione non resta aperta").toHaveAttribute("aria-expanded", "true", { timeout: 5000 });
}

/** La scatola della sezione — il contenitore che porta l'altezza, cioè il PADRE
 *  dell'intestazione. È lui che prima aveva `height: 200px`. */
async function scatola(win: import("@playwright/test").Locator, testid: string) {
  const box = win.getByTestId(testid).locator("xpath=..");
  const b = await box.boundingBox();
  if (!b) throw new Error(`nessun rettangolo per ${testid}`);
  return b;
}

/**
 * The same box, read once it has STOPPED moving: re-read until two consecutive
 * samples agree.
 *
 * Opening a section reflows the column, and this spec measures a rectangle — a
 * sample taken mid-reflow is a true number of a state that does not exist. That
 * is what the fixed 600 ms after each open was standing in for, and it is the
 * same bet the section-opening helper above already refused to make: wait for
 * the condition, not for a duration.
 */
async function settledSection(win: import("@playwright/test").Locator, testid: string) {
  let previous = "";
  let settled: Awaited<ReturnType<typeof scatola>> | null = null;
  await expect
    .poll(
      async () => {
        const b = await scatola(win, testid);
        const shot = JSON.stringify(b);
        const quiet = shot === previous;
        previous = shot;
        if (quiet) settled = b;
        return quiet;
      },
      { timeout: 10_000, message: `${testid}: la scatola non ha mai smesso di muoversi` },
    )
    .toBe(true);
  return settled!;
}

test.describe("colonna di progetto: altezza delle sezioni aperte", () => {
  const POCO = `/tmp/e2e-auto-poco-${Date.now()}`;

  test.beforeAll(() => {
    mkdirSync(POCO, { recursive: true });
    writeFileSync(`${POCO}/a.txt`, "uno\n");
    initGitRepo(POCO);
    // UNA sola modifica non committata: il caso in cui prima avanzavano ~160px
    // di vuoto dentro un pannello da 200.
    writeFileSync(`${POCO}/a.txt`, "due\n");
  });
  test.afterAll(() => { rmSync(POCO, { recursive: true, force: true }); });

  test("AUTOH-1: con poco contenuto la sezione non tiene più l'altezza fissa, e sta sotto il tetto", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "AUTOH-01" });
    const win = await apri(page, request, POCO);

    // Il contenitore delle sezioni: è lui la base del tetto `1/N`.
    const colonna = win.locator('[data-testid="project-sidebar"]');
    const cb = (await colonna.boundingBox())!;

    // Git aperta. `aria-expanded` è l'appiglio: l'etichetta è tradotta.
    await garantisciAperta(win.getByTestId("project-sidebar-processes"));

    // Il layout deve essersi fermato: una misura presa a metà del riflusso è un
    // numero vero di uno stato che non esiste.
    const g = await settledSection(win, "project-sidebar-processes");
    const tetto = cb.height / 3;

    expect(
      g.height,
      `Processi è alta ${g.height.toFixed(0)}px: se vale esattamente ${VECCHIA_ALTEZZA_PROCESSI} l'altezza è di nuovo quella fissa`,
    ).not.toBe(VECCHIA_ALTEZZA_PROCESSI);

    expect(
      g.height,
      `Processi è alta ${g.height.toFixed(0)}px contro un tetto di ${tetto.toFixed(0)} (1/3 di ${cb.height.toFixed(0)})`,
    ).toBeLessThanOrEqual(tetto + 2);

    // E non è collassata a zero: adattarsi al contenuto vuol dire mostrarlo.
    expect(g.height, "Processi aperta ma senza altezza: non si adatta, sparisce").toBeGreaterThan(40);
  });

  test("AUTOH-2: il tetto tiene, e Files non viene schiacciata", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "AUTOH-01" });
    const win = await apri(page, request, POCO);
    const colonna = win.locator('[data-testid="project-sidebar"]');
    const cb = (await colonna.boundingBox())!;

    await garantisciAperta(win.getByTestId("project-sidebar-processes"));

    const tetto = cb.height / 3 + 2;
    const b = await settledSection(win, "project-sidebar-processes");
    expect(b.height, `Processi è ${b.height.toFixed(0)}px, tetto ${tetto.toFixed(0)}`).toBeLessThanOrEqual(tetto);

    // …e Files, che assorbe il resto, non è stata schiacciata: è la ragione per
    // cui il tetto esiste.
    const f = await scatola(win, "project-sidebar-files");
    expect(f.height, `Files ridotta a ${f.height.toFixed(0)}px`).toBeGreaterThan(cb.height / 4);
  });
});
