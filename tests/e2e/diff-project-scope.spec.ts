/**
 * diff-project-scope.spec.ts — un diff si apre SOLO nella sua finestra.
 *
 * IL BUG. `open-file-diff` è un evento su `window`, e OGNI finestra di progetto
 * montata ci si iscrive. Il listener gemello di `open-file` aveva la guardia di
 * scoping, questo no: con due finestre affiancate (A e B), un click su un file
 * nel pannello Git di B faceva comparire la tab diff anche in A. E la tab
 * comparsa nella finestra sbagliata portava il `diffProjectPath` di B pur
 * essendo ospitata in A, quindi «Copia link» da lì produceva un link incoerente.
 *
 * PERCHÉ QUESTO TEST DISPACCIA L'EVENTO invece di cliccare nel pannello Git.
 * Il bug sta nell'INSTRADAMENTO dell'evento, non in chi lo emette. Costruire un
 * repo git con modifiche reali per far apparire una riga cliccabile proverebbe
 * la stessa cosa aggiungendo il rumore di git — e un rosso lì non direbbe se ad
 * essere rotto è lo scoping o il pannello. Qui l'evento è quello vero
 * (`GitChanges` dispatcha esattamente questo detail) e ad ascoltarlo sono i
 * listener veri delle due finestre montate.
 *
 * @covers FILE-02
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { collapseSidebarSections, splitViaContextMenu } from "./helpers/layout";
import { mkdirSync, rmSync } from "fs";

hermetic(test);

const PROJ_A = `/tmp/e2e-diffscope-a-${Date.now()}`;
const PROJ_B = `/tmp/e2e-diffscope-b-${Date.now()}`;

test.describe("open-file-diff — scoping alla finestra di progetto", () => {
  test.beforeAll(() => {
    for (const p of [PROJ_A, PROJ_B]) mkdirSync(p, { recursive: true });
  });
  test.afterAll(() => {
    for (const p of [PROJ_A, PROJ_B]) rmSync(p, { recursive: true, force: true });
  });

  test("il diff del progetto B non compare nella finestra di A", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ_A);
    await seedProjectPane(request, PROJ_B);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await collapseSidebarSections(page);

    // AFFIANCARLE è il punto. Due pane di progetto nello stesso gruppo sono due
    // TAB: solo l'attiva è montata, quindi solo lei ascolta, e il bug non si
    // manifesterebbe nemmeno. Il difetto vive quando entrambe sono montate
    // insieme — cioè in split, che è anche lo scenario segnalato.
    await expect(page.locator('[role="main"] [draggable="true"]').first()).toBeVisible({ timeout: 15000 });
    await splitViaContextMenu(page, "Dividi a destra", 0, 15000);

    // Entrambe le finestre di progetto devono essere montate, altrimenti il test
    // "passerebbe" per assenza dell'ascoltatore invece che per lo scoping.
    const winA = page.locator(`[data-testid="project-window"][data-project-path="${PROJ_A}"]`);
    const winB = page.locator(`[data-testid="project-window"][data-project-path="${PROJ_B}"]`);
    await expect(winA, "la finestra del progetto A deve essere montata").toHaveCount(1, { timeout: 15000 });
    await expect(winB, "la finestra del progetto B deve essere montata").toHaveCount(1, { timeout: 15000 });

    const tabsBefore = await page.locator('[data-pane-id^="diff:"]').count();
    expect(tabsBefore, "si parte senza alcuna tab diff").toBe(0);

    // L'evento ESATTO che GitChanges dispatcha per il progetto B.
    await page.evaluate((projectPath) => {
      window.dispatchEvent(
        new CustomEvent("open-file-diff", { detail: { filePath: "src/uno.ts", projectPath } }),
      );
    }, PROJ_B);

    // La tab diff nasce, e ne nasce UNA SOLA: prima ne nascevano due, una per
    // finestra montata. È la forma esatta del difetto — duplicazione.
    await expect
      .poll(() => page.locator('[data-pane-id^="diff:"]').count(), {
        timeout: 10000,
        message: "una tab diff, e una sola, deve comparire",
      })
      .toBe(1);

    // E deve stare dentro la finestra di B, non di A. Le due asserzioni servono
    // entrambe: il conteggio a 1 esclude la duplicazione, questa esclude che
    // l'unica tab sia nata nella finestra sbagliata.
    await expect(winB.locator('[data-pane-id^="diff:"]'), "la tab diff sta nella finestra di B").toHaveCount(1);
    await expect(winA.locator('[data-pane-id^="diff:"]'), "in A non deve esserci nessuna tab diff").toHaveCount(0);
  });
});
