/**
 * CONDIVIDERE UN PROGETTO, dal menu che si apre col tasto destro.
 *
 * Fino alla migration 20260816230500 un progetto non era una risorsa
 * condivisibile: `ResourceType` era `task | topic` e basta, quindi non c'era
 * niente da mostrare col tasto destro su di lui. Le colonne `via_type`/`via_id`
 * della 083 esistevano proprio per questo caso e restavano inerti, perché
 * «quel contenitore non esiste».
 *
 * Qui si verifica la strada scelta (espansione in lettura): una riga sola sul
 * progetto, e i suoi task la ereditano. Il gesto e il pannello sono gli stessi
 * di un task e di una chat, perché «con chi è condiviso» dev'essere una domanda
 * sola con una risposta sola.
  * @covers PRJSHARE-01
 */
import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { projectRow } from "./helpers/project-row";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

hermetic(test);

const PROJECT_PATH = `/tmp/e2e-share-project-${Date.now()}`;
const PROJECT_NAME = PROJECT_PATH.split("/").pop()!;

test.describe("Condividere un progetto", () => {
  let topicId: string | null = null;

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-share-project" }));
    const t = await createTopic(request, `E2E-ShareProject-${Date.now()}`, { projectPath: PROJECT_PATH });
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test("SHAREPRJ-01: il tasto destro sul progetto offre di condividerlo", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PRJSHARE-01" });
    await goToApp(page);
    const riga = projectRow(page, new RegExp(PROJECT_NAME));
    await expect(riga).toBeVisible({ timeout: 15000 });

    await riga.click({ button: "right" });
    const voce = page.getByTestId("project-share");
    await expect(voce, "la voce di condivisione deve esserci nel menu del progetto").toBeVisible({
      timeout: 10000,
    });
  });

  test("SHAREPRJ-02: la voce apre il pannello, e il pannello è quello di sempre", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PRJSHARE-01" });
    // Lo stesso `ShareControl` di un task e di una chat: un secondo pannello
    // scritto per l'occasione divergerebbe dal primo alla prima modifica.
    await goToApp(page);
    const riga = projectRow(page, new RegExp(PROJECT_NAME));
    await expect(riga).toBeVisible({ timeout: 15000 });
    await riga.click({ button: "right" });
    await page.getByTestId("project-share").click();

    const pannello = page.getByTestId("project-share-panel");
    await expect(pannello).toBeVisible({ timeout: 10000 });
    // Il titolo nomina il PROGETTO: «Condividi con un ospite» su tre cose
    // diverse è la stessa frase per tre gesti diversi, e chi la legge non sa
    // quale delle tre sta per uscire di casa.
    await expect(pannello).toContainText(new RegExp(PROJECT_NAME));
    await expect(pannello.getByTestId("share-control")).toBeVisible();
    await pannello.screenshot({ path: "test-results/share-progetto.png" });

    // The card is the one from the contract: `MODAL_PANEL` (hence
    // `native-occlude`, what freezes the native browser pane under the
    // backdrop) plus `role="dialog"`, what `hasOpenModalSurface()` looks for.
    // Without them Escape reached the global shortcut handler and stopped the
    // focused session's turn instead of closing the panel.
    await expect(
      page.locator(
        '[data-testid="project-share-panel"] .native-occlude, [data-testid="project-share-panel"][role="dialog"]',
      ),
    ).toHaveCount(1);

    // Escape closes it, like every other full-screen dialog.
    await page.keyboard.press("Escape");
    await expect(pannello).toHaveCount(0);

    // And a click outside closes it too: it is a panel, not a page.
    await riga.click({ button: "right" });
    await page.getByTestId("project-share").click();
    await expect(pannello).toBeVisible({ timeout: 10000 });
    await page.mouse.click(5, 5);
    await expect(pannello).toHaveCount(0);
  });
});
