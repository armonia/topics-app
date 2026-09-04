/**
 * ZERO MODIFICHE, ZERO SEZIONE.
 *
 * La sidebar mostrava «Modifiche git» anche su un repository pulito, con un
 * titolo che diceva zero file: una riga spesa per dire che non e' successo
 * niente, piu' il suo bottone nella striscia compatta. Qui si misurano i due
 * stati che una schermata sola non puo' provare: il progetto pulito NON ha la
 * sezione, e la prima modifica sul disco la fa tornare col conteggio.
 *
 * Il repo di prova e' vero (`initGitRepo`), non un mock: e' l'unico modo per
 * cui «pulito» qui voglia dire quello che vuol dire per git.
 *
 * @covers PROJECT-12
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { initGitRepo } from "./helpers/file-project";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

const PROJECT_DIR = `/tmp/e2e-git-empty-${Date.now()}`;

test.describe("sidebar progetto: la sezione git quando non c'e' niente", () => {
  test.beforeAll(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(`${PROJECT_DIR}/README.md`, "uno\n");
    // Tutto committato: nessun file modificato e nessun remoto, quindi nemmeno
    // avanti/indietro. E' lo stato in cui la sezione non deve esistere.
    initGitRepo(PROJECT_DIR, "primo");
  });
  test.afterAll(() => {
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  test("pulito non ha sezione ne' bottone, e la prima modifica la riporta", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PROJECT-12" });
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJECT_DIR);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJECT_DIR}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // La sezione File c'e' sempre: e' l'ancora che dice che la sidebar e'
    // montata e ha finito di caricare. Senza, l'assenza della sezione git
    // sarebbe vera anche su una sidebar che non c'e'.
    await expect(win.getByTestId("project-sidebar-files")).toBeVisible({ timeout: 15000 });

    const section = win.getByTestId("project-sidebar-git-section");
    // 1. PULITO: niente sezione. Si aspetta che lo stato git sia ARRIVATO
    //    (il pannello dei file e' visibile e la finestra e' viva) e si tiene
    //    l'assenza per un intervallo, perche' un'assenza immediata sarebbe
    //    vera anche solo perche' il render non e' ancora passato di li'.
    await expect(section).toHaveCount(0);
    await expect.poll(async () => section.count(), {
      // Il poll dello stato git e' 15s: se la sezione dovesse comparire per
      // uno zero, comparirebbe entro questa finestra.
      timeout: 18000,
      intervals: [1000],
      message: "la sezione git non deve comparire su un repo pulito",
    }).toBe(0);

    // 2. E LA STRISCIA COMPATTA nemmeno: il bottone che apre una sezione che
    //    non c'e' sarebbe un comando che non fa niente.
    await win.getByRole("button", { name: "Nascondi la barra" }).click();
    const strip = win.locator('[data-testid="project-rail-inline"]');
    await expect(strip).toBeVisible({ timeout: 5000 });
    await expect(strip.getByRole("button", { name: /Modifiche git/ })).toHaveCount(0);

    // 3. LA PRIMA MODIFICA LA RIPORTA. La condizione e' viva: nessuno riapre
    //    il progetto, cambia solo il disco.
    writeFileSync(`${PROJECT_DIR}/README.md`, "uno\ndue\n");
    await expect(strip.getByRole("button", { name: /Modifiche git/ })).toHaveCount(1, { timeout: 25000 });

    // E riaperta, la sezione c'e' col suo conteggio: quello non e' cambiato.
    await win.getByRole("button", { name: "Espandi la barra" }).click();
    await expect(win.getByTestId("project-sidebar-git-section")).toBeVisible({ timeout: 15000 });
  });
});
