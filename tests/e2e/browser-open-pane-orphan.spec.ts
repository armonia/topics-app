/**
 * «APERTO» DEVE VOLER DIRE VISTO.
 *
 * Il guasto, visto in sessione reale l'11/08/2026: un agente chiama
 * `open_browser_pane({url})` su una topic SENZA progetto mentre nel workspace
 * c'è anche una tab di progetto aperta. Il server crea il contesto browser (che
 * poi compare in `browser_list_tabs`, risponde a `browser_status`, ha la pagina
 * caricata) e il tool risponde «Opened browser pane at …» — ma sullo schermo non
 * compare NIENTE: il frame `browser:navigate` cadeva fra i due consumatori, il
 * gruppo standalone lo scaricava sulla finestra di progetto («ci pensa lei») e
 * quella lo rifiutava perché la topic non era sua.
 *
 * Questo file prova il giro INTERO sulla stessa porta che usa l'agente
 * (`POST /api/topics/:id/browser/open-pane`, cioè il tool MCP), con la
 * precondizione esatta del guasto: topic senza progetto + pane di progetto
 * aperta nello stesso gruppo.
 *
 * @covers BROWSER-CHAT-04
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  closeAllBrowserContexts,
  waitForTopicVisible,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = join(tmpdir(), "e2e-open-pane-orphan");
// Una pagina SENZA RETE (data:), così un rosso di rete non si travestirebbe da
// rosso di prodotto — ma con del contenuto ben visibile, perché la clip di
// consegna deve mostrare che il pannello si è aperto DAVVERO, non un rettangolo
// bianco indistinguibile dallo sfondo.
const OPEN_URL =
  "data:text/html,<body style='margin:0;background:%23101418;color:%2360f0a0;font:700 72px system-ui;display:grid;place-items:center'>PANE VISIBILE</body>";

let topicId = "";

test.describe("open_browser_pane monta un pannello anche fuori da un progetto", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-open-pane-orphan" }, null, 2));
    // NIENTE projectPath: è la topic «orfana» del guasto.
    const topic = await createTopic(request, "E2E-OpenPane-Orfana");
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    await closeAllBrowserContexts(request);
    if (topicId) await deleteTopic(request, topicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test("topic senza progetto + tab di progetto aperta: il pannello compare, e la risposta dice visible", async ({ page }) => {
    const beat = (ms: number) =>
      process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

    // La precondizione del guasto: la chat orfana E una tab di progetto, nello
    // stesso gruppo. Bastava la seconda perché il gruppo standalone si tirasse
    // indietro su OGNI browser:navigate.
    await resetPaneStore(page.request, [topicId]);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);

    await goToApp(page);
    await waitForTopicVisible(page, topicId, { timeout: 15_000 });
    // Prima: nessun pannello browser da nessuna parte.
    await expect(page.locator('[data-browser-pane]')).toHaveCount(0);
    await beat(1200);

    // La porta dell'agente, non una scorciatoia del test.
    const resp = await page.request.post(
      `${BASE}/api/topics/${encodeURIComponent(topicId)}/browser/open-pane`,
      { data: { url: OPEN_URL }, ignoreHTTPSErrors: true },
    );
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as { url?: string; visible?: boolean };

    // Dopo: il pannello c'è.
    await expect(page.locator('[data-browser-pane]').first()).toBeVisible({ timeout: 15_000 });
    // E la risposta lo DICE — il secondo mezzo guasto: finché il messaggio era
    // identico nei due casi, nessuno poteva accorgersi del primo.
    expect(body.visible, "la rotta deve confermare un pannello VISIBILE, non solo un contesto vivo").toBe(true);
    // In modalità evidenza si aspetta anche che la PAGINA si dipinga dentro il
    // pannello: la clip di consegna deve mostrare il contenuto, non solo la
    // cornice appena montata.
    await beat(4000);
  });
});
