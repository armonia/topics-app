/**
 * FOCUS-BOUNCE — «apro il progetto dalla sidebar, faccio nuova chat, mi
 * riporta a board».
 *
 * Segnalazione dell'utente (desktop): la pane utility `__board__` è a fuoco,
 * si apre un PROGETTO dalla sidebar (il fuoco passa a `project:<path>`), si
 * chiede una chat nuova — e il fuoco della finestra torna su `__board__`.
 *
 * L'imputato è `deepLinkFocusRef` in client/src/hooks/usePanelLifecycle.ts:
 * armato su `topics:open-task` (riga ~1075), riapplicato come fuoco a OGNI bump
 * di `lastSeq` dello store con priorità sopra tutto (Effect A, righe ~508-509):
 *
 *     const intent = deepLinkFocusRef.current;
 *     if (intent && storeOrder.includes(intent)) return intent;
 *
 * Rilasciato da `topics:task-opened`, da handleTopicClick e da handleFocusPanel.
 * NON lo rilasciava handleProjectClick, che è la porta del click sul progetto
 * in sidebar — quindi con un intento ancora armato qualunque mutazione dello
 * store fatta DOPO (creare una chat) riporta il fuoco sulla board.
 *
 * COME SI ARMA L'INTENTO SENZA CHE VENGA MAI RILASCIATO. `topics:open-task`
 * arma; l'ack `topics:task-opened` lo emette il drawer SOLO quando il task si
 * risolve davvero. Su un id che non esiste KanbanBoardPane azzera
 * `pendingSelect` e non emette niente: l'intento resta armato per sempre. È il
 * vicolo cieco che questi test usano, e non è artificiale — è la notifica di un
 * task poi cancellato, o un permalink vecchio.
 *
 * COSA MISURA. Sempre la stessa cosa: quale pane è attiva nella barra di
 * livello app (`data-active="true"`, PaneTabBar.tsx:1104-1105) dopo il gesto,
 * campionata per 5 secondi — un rimbalzo differito di un tick non deve sfuggire.
 *
 * SEMINA (il punto in cui questa spec è già stata rotta una volta). La sidebar
 * è tab-driven: un progetto compare solo se la sua pane è aperta OPPURE se un
 * suo figlio ha una tab aperta (`lib/buildSidebarItems.ts`, «Build project
 * items»). Un `resetPaneStore(request, [])` toglie ogni tab e con essa la riga
 * del progetto: il test moriva sul locator, senza mai eseguire il gesto. Qui si
 * semina quindi la tab della CHAT del progetto — che fa comparire la riga —
 * lasciando la pane del progetto CHIUSA, così il click la apre davvero.
 */
import { expect, test, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { projectRow } from "./helpers/project-row";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const STAMP = Date.now();
const PROJECT_PATH = `/tmp/e2e-focus-bounce-${STAMP}`;
/** `createPaneId('project', path)` — state/pane/adapters/paneConfig.ts:150. */
const PROJECT_PANE = `project:${encodeURIComponent(PROJECT_PATH)}`;
const BOARD_PANE = "__board__";
/** Un task che non esiste: il drawer non lo risolve, `topics:task-opened` non
 *  parte, l'intento resta ARMATO. */
const TASK_FANTASMA = "00000000-0000-4000-8000-000000000000";

/**
 * Le pane ATTIVE della barra di livello app. Le barre dentro `project-window`
 * hanno i loro `data-active` (le tab INTERNE al progetto) e non c'entrano: qui
 * interessa quale finestra è davanti, non cosa mostra dentro.
 */
async function activeTopLevelPanes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-pane-id][data-active="true"]'))
      .filter((el) => !el.closest('[data-testid="project-window"]'))
      .map((el) => el.getAttribute("data-pane-id") ?? ""),
  );
}

/**
 * Guarda per `ms` se la board torna davanti. Il rimbalzo arriva al PROSSIMO
 * bump di `lastSeq`, che può essere una dispatch differita (l'effetto che
 * monta la chat dentro la finestra progetto, un broadcast WS): una lettura
 * sola subito dopo il click direbbe «verde» su un bug che c'è.
 */
async function watchFocus(page: Page, ms: number): Promise<{ boardTornata: boolean; visti: string[] }> {
  const visti: string[] = [];
  let boardTornata = false;
  const fine = Date.now() + ms;
  while (Date.now() < fine) {
    const attive = await activeTopLevelPanes(page);
    const key = attive.join(",") || "(nessuna)";
    if (visti[visti.length - 1] !== key) visti.push(key);
    if (attive.includes(BOARD_PANE)) boardTornata = true;
    await page.waitForTimeout(120);
  }
  return { boardTornata, visti };
}

/** Apre la board generale dal menu «+» della barra standalone e la mette a fuoco. */
async function apriBoard(page: Page) {
  await page.locator('[aria-label="Topics sidebar"] [data-testid="pane-add-menu-trigger"]').first().click();
  await page.getByTestId("pane-add-menu").getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(`[data-pane-id="${BOARD_PANE}"]`).first())
    .toHaveAttribute("data-active", "true", { timeout: 10000 });
}

/** Il click sul NOME del progetto nella sidebar → `onProjectClick` =
 *  handleProjectClick (TopicTree.tsx: desktop, progetto non a fuoco). */
async function apriProgettoDaSidebar(page: Page) {
  const riga = projectRow(page, new RegExp(`e2e-focus-bounce-${STAMP}`));
  await expect(riga, "la riga del progetto deve essere in sidebar").toBeVisible({ timeout: 15000 });
  await riga.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

/** «New Chat» dal menu «+» DENTRO la finestra progetto. */
async function newChatDalProgetto(page: Page) {
  await page.getByTestId("project-window").getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu").getByTestId("pane-add-menu-new-chat").click();
}

/** «New Chat» dal menu «+» GLOBALE della sidebar. */
async function newChatGlobale(page: Page) {
  const trigger = page.locator('[aria-label="Topics sidebar"] [data-testid="pane-add-menu-trigger"]').first();
  await expect(trigger).toBeVisible({ timeout: 10000 });
  await trigger.click();
  await page.getByTestId("pane-add-menu").getByTestId("pane-add-menu-new-chat").click();
}

/** Arma l'intento come lo arma un deep-link di task già in-app (openTaskInApp). */
async function armaIntento(page: Page) {
  await page.evaluate((taskId) => {
    window.dispatchEvent(new CustomEvent("topics:open-task", { detail: { taskId } }));
  }, TASK_FANTASMA);
  await page.waitForTimeout(600);
}

test.describe.serial("FOCUS-BOUNCE — il fuoco che torna sulla board", () => {
  let topicId = "";

  test.beforeAll(async ({ request }) => {
    const t = await createTopic(request, `E2E-FocusBounce-${STAMP}`, { projectPath: PROJECT_PATH });
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  /**
   * Semina la scena e porta la board a fuoco.
   * `progettoGiaAperto`: la pane del progetto è già una tab in secondo piano
   * (il caso comune) invece di nascere dal click.
   */
  async function scena(
    page: Page,
    request: APIRequestContext,
    opts: { progettoGiaAperto?: boolean } = {},
  ) {
    // La tab della CHAT del progetto è ciò che fa comparire la riga in sidebar
    // (sidebar tab-driven). La pane del progetto resta fuori, così il click la apre.
    const seed = opts.progettoGiaAperto ? [topicId, PROJECT_PANE] : [topicId];
    await resetPaneStore(request, seed);
    await goToApp(page);
    await apriBoard(page);
  }

  test("FOCUS-01: senza intento armato — «+ New Chat» della finestra progetto", async ({ page, request }) => {
    await scena(page, request);
    await apriProgettoDaSidebar(page);
    expect(await activeTopLevelPanes(page), "il click sul progetto deve portare il fuoco sulla sua finestra")
      .toContain(PROJECT_PANE);

    await newChatDalProgetto(page);
    const { boardTornata, visti } = await watchFocus(page, 5000);
    expect(boardTornata, `fuoco osservato dopo «New Chat»: ${JSON.stringify(visti)}`).toBe(false);
  });

  test("FOCUS-02: senza intento armato — «New Chat» globale della sidebar", async ({ page, request }) => {
    await scena(page, request);
    await apriProgettoDaSidebar(page);
    expect(await activeTopLevelPanes(page)).toContain(PROJECT_PANE);

    await newChatGlobale(page);
    const { boardTornata, visti } = await watchFocus(page, 5000);
    expect(boardTornata, `fuoco osservato dopo «New Chat»: ${JSON.stringify(visti)}`).toBe(false);
  });

  test("FOCUS-03: intento ARMATO — «+ New Chat» della finestra progetto", async ({ page, request }) => {
    await scena(page, request);
    await armaIntento(page);
    await apriProgettoDaSidebar(page);
    expect(await activeTopLevelPanes(page), "il click sul progetto deve portare il fuoco sulla sua finestra")
      .toContain(PROJECT_PANE);

    await newChatDalProgetto(page);
    const { boardTornata, visti } = await watchFocus(page, 5000);
    expect(boardTornata, `fuoco osservato dopo «New Chat»: ${JSON.stringify(visti)}`).toBe(false);
  });

  test("FOCUS-04: intento ARMATO — «New Chat» globale della sidebar", async ({ page, request }) => {
    await scena(page, request);
    await armaIntento(page);
    await apriProgettoDaSidebar(page);
    expect(await activeTopLevelPanes(page)).toContain(PROJECT_PANE);

    await newChatGlobale(page);
    const { boardTornata, visti } = await watchFocus(page, 5000);
    expect(boardTornata, `fuoco osservato dopo «New Chat»: ${JSON.stringify(visti)}`).toBe(false);
  });

  test("FOCUS-05: intento ARMATO — progetto GIÀ APERTO in secondo piano", async ({ page, request }) => {
    // La differenza non è cosmetica: con la pane già nello store
    // `ensurePaneRegistered` esce subito e handleProjectClick non dispatcha
    // niente, quindi il primo bump di `lastSeq` arriva solo con «New Chat».
    await scena(page, request, { progettoGiaAperto: true });
    await armaIntento(page);
    await apriProgettoDaSidebar(page);
    expect(await activeTopLevelPanes(page)).toContain(PROJECT_PANE);

    await newChatDalProgetto(page);
    const { boardTornata, visti } = await watchFocus(page, 5000);
    expect(boardTornata, `fuoco osservato dopo «New Chat»: ${JSON.stringify(visti)}`).toBe(false);
  });

  test("FOCUS-06: intento ARMATO A FREDDO via URL `/task/<id>` — «+ New Chat» del progetto", async ({ page, request }) => {
    // La via vera dell'utente: si arriva sulla board CLICCANDO un task (notifica,
    // permalink). `openTaskFromUrl` apre la board e arma l'intento al boot.
    await resetPaneStore(request, [topicId]);
    await page.goto(`/task/${TASK_FANTASMA}`);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.locator(`[data-pane-id="${BOARD_PANE}"]`).first())
      .toHaveAttribute("data-active", "true", { timeout: 15000 });

    await apriProgettoDaSidebar(page);
    expect(await activeTopLevelPanes(page), "il click sul progetto deve portare il fuoco sulla sua finestra")
      .toContain(PROJECT_PANE);

    await newChatDalProgetto(page);
    const { boardTornata, visti } = await watchFocus(page, 5000);
    expect(boardTornata, `fuoco osservato dopo «New Chat»: ${JSON.stringify(visti)}`).toBe(false);
  });
});
