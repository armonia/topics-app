/**
 * I COMANDI NASCOSTI DIETRO L'HOVER, MISURATI COL DITO.
 *
 * Nove file scrivevano a mano `opacity-0 group-hover:opacity-100`. È una classe
 * che Tailwind mette dentro `@media (hover: hover)`: su un device senza
 * puntatore non si accende MAI, quindi il comando non è «meno visibile», è
 * irraggiungibile. E `opacity: 0` non toglie l'hit-test — sulla lista dei
 * branch restava un bersaglio invisibile da 14px («cancella branch») a 8px dal
 * bordo di una riga il cui tocco fa checkout.
 *
 * La regola sta in `client/src/lib/hoverReveal.ts` (unit test accanto). Questa
 * spec prova le due cose che una costante non può provare da sola, sul caso
 * peggiore e nell'app vera:
 *
 *   (a) il comando è RAGGIUNGIBILE con un gesto reale — «tieni premuto» apre
 *       lo stesso menu del tasto destro, e lì dentro c'è «Delete branch»;
 *   (b) non resta NESSUN bersaglio invisibile — `elementFromPoint` sul punto
 *       del comando nascosto non deve restituire quel bottone.
 *
 * Gira nel progetto `chromium-touch-wide` (playwright.config.ts): `hasTouch` +
 * `isMobile` sono ciò che spegne `(hover: hover)` e accendono
 * `navigator.maxTouchPoints`, cioè i due segnali su cui l'app decide. La
 * viewport resta larga perché il pannello git vive nella barra laterale del
 * progetto, che a 390px è un altro layout: qui si prova il ramo TOUCH, non il
 * ramo MOBILE — sono due domande diverse (vedi `hooks/useMobile.ts`).
  * @covers HOVERTOUCH-01
 */
import { expect } from "@playwright/test";
import { execFileSync } from "child_process";
import { test } from "./fixtures/file-explorer.fixture";
import { resetPaneStore } from "./helpers/api-fixtures";
import { seedFileProject, cleanupFileProject, type FileProject } from "./helpers/file-project";
import { longPress } from "./helpers/long-press";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Il branch che NON è quello corrente: è l'unico che porta il comando «elimina». */
const ALTRO_BRANCH = "tocco/da-cancellare";

/**
 * Apre la sezione Git della barra laterale, che nasce chiusa.
 *
 * Si clicca l'ETICHETTA e non il centro della riga: al centro c'è il nome del
 * ramo, che è un CONTROLLO — cliccarlo apre la tendina dei rami e la sezione
 * resta chiusa.
 */
async function apriGit(page: import("@playwright/test").Page) {
  const gitChanges = page.locator('[data-testid="git-changes"]');
  await expect(gitChanges).toBeVisible({ timeout: 15000 });
  const header = gitChanges.locator('[data-testid="project-sidebar-git"]');
  await expect(header).toBeVisible({ timeout: 10000 });
  if ((await header.getAttribute("aria-expanded")) !== "true") {
    await header.getByText("Git", { exact: true }).click();
  }
  return gitChanges;
}

/** Apre la tendina dei rami e aspetta che la riga dell'altro branch ci sia. */
async function apriRami(page: import("@playwright/test").Page) {
  await page.locator('[data-testid="git-branch-button"]').click();
  const riga = page.locator(`[data-testid="branch-row"][data-branch="${ALTRO_BRANCH}"]`);
  await expect(riga).toBeVisible({ timeout: 10000 });
  return riga;
}

test.describe("comandi nascosti dietro l'hover, col dito", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "hover-reveal");
    ({ topicId, tmpDir, topicName } = project);
    // Un secondo branch: senza, la lista ha solo quello corrente e il comando
    // «elimina» non esiste su nessuna riga — la spec passerebbe a vuoto.
    execFileSync("git", ["branch", ALTRO_BRANCH], { cwd: tmpDir });
  });
  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  /**
   * IL CANCELLO DELLA SPEC.
   *
   * Se questo progetto girasse con un puntatore, i due test qui sotto
   * proverebbero l'esatto contrario di ciò che affermano — in verde. La prima
   * asserzione è quindi sul CONTESTO, non sull'app.
   */
  test("HOVER-TOUCH-00: il contesto è davvero senza puntatore", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HOVERTOUCH-01" });
    await page.goto("/");
    const segnali = await page.evaluate(() => ({
      hasHover: window.matchMedia("(hover: hover)").matches,
      coarse: window.matchMedia("(pointer: coarse)").matches,
      touchPoints: navigator.maxTouchPoints,
    }));
    expect(segnali.hasHover).toBe(false);
    expect(segnali.coarse).toBe(true);
    expect(segnali.touchPoints).toBeGreaterThan(0);
  });

  test("HOVER-TOUCH-01: «elimina branch» è raggiungibile tenendo premuto", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "HOVERTOUCH-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    await apriGit(page);
    await apriRami(page);

    // Il gesto standard dell'app. `openContextMenuAt` sintetizza il
    // `contextmenu` che l'handler della riga già ascolta: è LO STESSO menu del
    // tasto destro, non un secondo da tenere allineato.
    const voce = page.locator('[data-testid="branch-menu-delete"]');
    // The finger stays down until the menu is THERE, instead of a flat 750 ms:
    // the app arms the gesture at 500 ms on the SAME thread that renders, so
    // under load that timer fires late and a timed hold has already let go —
    // the cause of `board-card-stop`'s red on 26/08.
    await longPress(page, `[data-testid="branch-row"][data-branch="${ALTRO_BRANCH}"]`, { until: voce });
    await expect(voce).toBeVisible({ timeout: 5000 });
    await voce.click();

    // E porta dove deve: il dialogo di conferma, col nome del branch.
    await expect(page.getByText(ALTRO_BRANCH, { exact: false }).last()).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /^Delete$/ })).toBeVisible({ timeout: 5000 });
  });

  test("HOVER-TOUCH-02: nessun bersaglio invisibile resta cliccabile", async ({
    fileExplorerPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "HOVERTOUCH-01" });
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    await apriGit(page);
    await apriRami(page);

    const bottone = page.locator(
      `[data-testid="branch-row"][data-branch="${ALTRO_BRANCH}"] [data-testid="branch-delete"]`,
    );
    await expect(bottone).toHaveCount(1);

    // Non si chiede a Playwright se «è visibile»: si misura il DOM. Le due cose
    // che contano sono l'opacità (il comando non si vede) e `pointer-events`
    // (il comando non si prende il tocco) — e devono valere INSIEME.
    const misura = await bottone.evaluate(el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const sotto = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        // `contains` e non `===`: il bersaglio potrebbe essere l'<svg> dentro
        // il bottone, che è comunque il bottone che si prende il tocco.
        colpisceIlBottone: !!sotto && el.contains(sotto),
      };
    });

    expect(misura.opacity).toBe("0");
    expect(misura.pointerEvents).toBe("none");
    expect(misura.colpisceIlBottone).toBe(false);
  });
});
