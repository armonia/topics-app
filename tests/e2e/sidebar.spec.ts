import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  createTerminalSession,
  deleteTerminalSession,
  deleteAllTerminalSessions,
  patchTopic,
  resetPaneStore,
  seedProjectPane,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { PAGE_LAYER_SELECTOR, SIDEBAR_SELECTOR, luminance, surfaceBg } from "./helpers/surfaces";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const created: { topics: string[]; terminals: string[] } = {
  topics: [],
  terminals: [],
};

/** Il progetto a cui è legata `created.topics[0]`. */
const PROJECT_PATH = "/tmp/e2e-sidebar-project";

/** Le cartelle usa-e-getta create da AC-1 (una per esecuzione), rimosse in
 *  `afterAll`: il progetto dell'accordion deve essere vergine a ogni tentativo. */
const accordionDirs: string[] = [];

test.describe("Sidebar — Unified Timeline", () => {
  test.beforeAll(async ({ request }) => {
    // Reset sidebar state to clean defaults (include all legacy fields to prevent migration from old values)
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        showProjects: true,
        showChats: true,
        showTerminals: true,
        showProjectsArchived: false,
        showChatsArchived: false,
        browserExpanded: false,
      },
    });

    // Create test data: a project topic, a standalone chat, and a terminal
    const projectTopic = await createTopic(request, "E2E-ProjectChat", {
      projectPath: PROJECT_PATH,
    });
    created.topics.push(projectTopic.id);

    const standaloneChat = await createTopic(request, "E2E-StandaloneChat");
    created.topics.push(standaloneChat.id);

    const terminal = await createTerminalSession(request, {
      cwd: "/tmp",
      type: "shell",
      name: "E2E-TestTerminal",
    });
    created.terminals.push(terminal.id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of created.topics) {
      await deleteTopic(request, id);
    }
    for (const id of created.terminals) {
      await deleteTerminalSession(request, id);
    }
    const { rmSync } = await import("node:fs");
    for (const dir of accordionDirs) rmSync(dir, { recursive: true, force: true });
  });

  // AC-1: Timeline view — all items in a single flat list
  test("SIDEBAR-1: timeline view shows items in a single list", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "TOPIC-02",
    });

    // Pre-open tabs so items appear in sidebar
    await request.put(`${E2E_BASE}/api/ui-state/panels`, {
      data: { openPanels: [created.topics[1], `terminal:${created.terminals[0]}`] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // The sidebar tree should be visible
    const sidebar = page.getByRole("tree", { name: "Barra laterale" });
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Items with open tabs should be visible
    await expect(
      page.getByRole("treeitem", { name: /E2E-StandaloneChat/ })
    ).toBeVisible({ timeout: 5000 });
  });

  // AC-1: l'accordion di un progetto elenca le chat APERTE DENTRO di lui, e il
  // chevron le richiude e le riapre.
  //
  // PERCHÉ ERA `fixme`, E PERCHÉ NON ERA UN BUG DELLA SIDEBAR.
  // Il test seminava la chat del progetto come pane di PRIMO LIVELLO (`panes:
  // { [topicId]: … }` dentro `group:default`) e poi si aspettava di ritrovarla
  // sotto il progetto. Quel seme non sopravvive al primo render: Effect 7 di
  // `usePanelLifecycle` (`opensAsProjectPane`) CONVERTE la pane di una chat
  // legata a un progetto nella pane del PROGETTO e purga quella sciolta
  // (`PURGE_ORPHAN_PANE`) — è lo stesso avvertimento già scritto nel docstring
  // di `seedProjectPane` in helpers/api-fixtures.ts. Misurato il 07/08 con una
  // sonda sullo stesso seme: dopo il caricamento il pane-store del server
  // conteneva SOLO `project:%2Ftmp%2Fe2e-probe-accordion` — la pane della chat
  // non esisteva più — e il «No chats open» dello screenshot del fallimento era
  // il vuoto di `GroupLayout` (il pannello del progetto al centro), non la
  // sidebar.
  //
  // Quindi l'accordion vuoto NON era il bug: la sidebar è guidata dalle TAB
  // (buildSidebarItems §2) e i figli di un progetto sono le pane aperte DENTRO
  // la sua finestra (`projectOpenPanes` ∪ layout persistito). Una chat che
  // esiste nel DB ma non è aperta da nessuna parte non è una riga — ed è
  // esattamente ciò che diceva anche il pannello del progetto («No chats
  // open»): le due superfici erano d'accordo, non in disaccordo. Il test
  // descrive ora quel contratto e il gesto dell'AC.
  test("SIDEBAR-1b: l'accordion del progetto elenca le chat aperte dentro, e si chiude e riapre", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "TOPIC-09",
    });

    // Progetto DEDICATO, con un nome nuovo a ogni esecuzione. Non è vezzo: il
    // layout interno di un progetto (`topics-project-panes-<hash>`) è
    // persistito sul server e RI-LETTO all'apertura (`loadProjectLayout`),
    // quindi riusando lo stesso path un secondo tentativo — su CI i retry sono
    // due — ripartirebbe con le chat aperte dal primo, e la premessa «questo
    // progetto non ha chat aperte» sarebbe vera solo alla prima passata.
    const projectPath = `/tmp/e2e-accordion-${Date.now()}`;
    const projectName = projectPath.slice("/tmp/".length);
    // Il pannello di progetto monta pane che ci entrano dentro (File, Git): la
    // cartella deve esistere davvero.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(projectPath, { recursive: true });
    accordionDirs.push(projectPath);

    // Una chat che ESISTE nel progetto e non è aperta da nessuna parte: è il
    // caso su cui il vecchio test si era arenato.
    const closed = await createTopic(request, "E2E-AccordionClosed", { projectPath });
    created.topics.push(closed.id);
    // La premessa è «la tab del progetto è aperta», e si semina come fa la UI:
    // la pane `project:<path>`. Additivo (vedi `seedProjectPane`), così le tab
    // seminate dagli altri test di questo file restano dove sono.
    await seedProjectPane(request, projectPath);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    const projectRow = page.getByTestId(`project-toggle-${projectName}`);
    await expect(projectRow).toBeVisible({ timeout: 10000 });

    // Un click sul nome porta il fuoco sul progetto E apre l'accordion (il
    // ramo `!isProjectFocused` di TopicTree). Serve anche perché la finestra
    // del progetto si disegna solo quando la sua è la tab attiva del gruppo:
    // le altre tab di questo file restano aperte, e senza il click al centro
    // ci sarebbe la loro.
    await projectRow.click();
    await expect(
      page.getByRole("button", { name: `Collapse ${projectName}` }),
      "il click sul nome apre l'accordion",
    ).toBeVisible({ timeout: 10000 });

    // 1. Contratto guidato dalle tab: `E2E-AccordionClosed` esiste in questo
    //    progetto ma non è aperta dentro di lui, quindi — ad accordion APERTO —
    //    non è una riga, e il pannello del progetto dice la stessa identica
    //    cosa. Le due superfici sono d'accordo: è QUESTO che il vecchio test
    //    leggeva come un buco.
    const emptyProject = page.getByText("No chats open", { exact: true });
    await expect(emptyProject).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("treeitem", { name: "E2E-AccordionClosed" }),
      "una chat mai aperta dentro il progetto non è una riga dell'accordion",
    ).toHaveCount(0);

    // 2. Si apre una chat DENTRO il progetto, dal suo stesso vuoto: la riga
    //    compare nell'accordion. È il gesto vero, non un seme.
    const created1 = page.waitForResponse(
      (r) => r.url().endsWith("/api/topics") && r.request().method() === "POST",
    );
    await emptyProject
      .locator("xpath=following-sibling::button[normalize-space()='New Chat']")
      .click();
    const openedId = ((await (await created1).json()) as { id: string }).id;
    created.topics.push(openedId);
    // Rinominata via API solo per avere un nome accessibile distinto: la riga
    // legge `topic.name` dallo store, aggiornato dal WS.
    await patchTopic(request, openedId, { name: "E2E-AccordionOpen" });
    const openedRow = page.getByRole("treeitem", { name: "E2E-AccordionOpen" });
    await expect(openedRow).toBeVisible({ timeout: 15000 });

    // 3. Una seconda chat creata ALTROVE (altro dispositivo / altra finestra):
    //    la finestra di progetto le apre una pane da sola (ramo delta di
    //    useProjectChatSync) e anche lei diventa una riga.
    const remote = await createTopic(request, "E2E-AccordionRemote", {
      projectPath,
    });
    created.topics.push(remote.id);
    const remoteRow = page.getByRole("treeitem", { name: "E2E-AccordionRemote" });
    await expect(remoteRow).toBeVisible({ timeout: 15000 });

    // 4. Il chevron CHIUDE l'accordion: sparisce ciò che non è la chat attiva.
    //    La chat attiva resta appesa sotto la riga del progetto anche da chiuso
    //    — è il ramo «Pinned active topic when collapsed» di TopicTree, e non
    //    dipende dall'accordion: senza questa asserzione «chiuso» e «aperto»
    //    sarebbero indistinguibili per la riga che stai guardando.
    await page.getByRole("button", { name: `Collapse ${projectName}` }).click();
    await expect(remoteRow).toBeHidden({ timeout: 10000 });
    await expect(
      openedRow,
      "la chat ATTIVA del progetto resta visibile anche ad accordion chiuso",
    ).toBeVisible();
    await expect(openedRow).toHaveAttribute("aria-selected", "true");

    // 5. E lo RIAPRE: torna l'elenco completo.
    await page.getByRole("button", { name: `Expand ${projectName}` }).click();
    await expect(remoteRow).toBeVisible({ timeout: 10000 });
    await expect(openedRow).toBeVisible();
  });

  // AC-2: il toggle cicla fra le TRE viste.
  //
  // Era un test su due modi (timeline ⇄ per tipo) e falliva alla terza asserzione
  // appena la vista per STATO è entrata nel ciclo: dopo "per tipo" l'etichetta non
  // dice più "Vista timeline" ma "Vista per stato". Non è una rottura da aggirare
  // — il ciclo è cambiato di proposito (FASE 2, AC c) — quindi il test percorre
  // ora l'anello intero e verifica che si torni al punto di partenza.
  test("SIDEBAR-2: view toggle cicla timeline → per tipo → per stato → timeline", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "TOPIC-02",
    });

    // Il modo "per tipo" e' stato RIMOSSO (Attilio, 06/08): sapere che una cosa
    // e' una chat o un terminale non aiuta a decidere cosa guardare — il tipo si
    // vede gia' dal glifo di ogni riga, quindi la sezione ripeteva
    // un'informazione che era gia' li' e in cambio spezzava la lista. Restano
    // due modi, e il giro e' fra quei due.
    await request.put(`${E2E_BASE}/api/ui-state/panels`, {
      data: { openPanels: [created.topics[1]] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // The view-mode + archived toggles relocated from the old <SidebarControls>
    // row into the "Topics ▾" header menu (App.tsx). Open it to reach them.
    const topicsMenuBtn = page.locator('button[title="Settings & Tools"]');
    await topicsMenuBtn.click();

    // Il modo per tipo non e' piu' nemmeno offerto.
    await expect(page.getByRole("button", { name: "Vista per tipo" })).toHaveCount(0);

    // Timeline → per stato. L'etichetta dice il modo SUCCESSIVO.
    const statoToggle = page.getByRole("button", { name: "Vista per stato" });
    await expect(statoToggle).toBeVisible({ timeout: 5000 });
    await statoToggle.click();

    // Vista per stato: le sezioni sono gli STATI, mai i tipi.
    await expect(
      page.locator('[data-testid="sidebar-state-section-rest"]')
    ).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByRole("button", { name: /sezione Chat/ })
    ).toHaveCount(0);

    // Il giro si chiude in due: da "per stato" si torna a timeline.
    const timelineToggle = page.getByRole("button", { name: "Vista timeline" });
    await expect(timelineToggle).toBeVisible({ timeout: 3000 });
    await timelineToggle.click();

    // Timeline: nessuna sezione di nessun genere.
    await expect(
      page.getByRole("button", { name: /sezione Chat/ })
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="sidebar-state-section-rest"]')
    ).toBeHidden({ timeout: 3000 });
  });

  // AC-3: Archive toggle shows/hides archived items
  test("SIDEBAR-3: archive toggle shows and hides archived items", async ({
    page,
    request,
  }) => {
    // Create and archive a topic with unique name
    const uniqueName = `E2E-ArchivedChat-${Date.now()}`;
    const archiveTopic = await createTopic(request, uniqueName);
    created.topics.push(archiveTopic.id);

    // Archive it via API (DELETE with body { archived: true } = archive, not delete)
    await request.delete(
      `${E2E_BASE}/api/topics/${archiveTopic.id}`,
      { data: { archived: true } }
    );

    // Ensure clean sidebar state on server — set showArchived=false
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], showProjectsArchived: false, showChatsArchived: false },
    });

    // Verify it was saved
    const verifyRes = await request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
    const verifyData = await verifyRes.json();
    console.log("[ARCHIVE] Server state after reset:", JSON.stringify(verifyData));

    await goToApp(page);

    const archivedItem = page.getByRole("treeitem", { name: new RegExp(uniqueName) }).first();

    // With showArchived=false, the item should be hidden
    await expect(archivedItem).toBeHidden({ timeout: 5000 });

    // The archived toggle relocated into the "Topics ▾" header menu (App.tsx).
    // It's a single row ("Mostra archiviati") that flips showArchived on each
    // click; the menu stays open, so the same locator toggles both ways.
    await page.locator('button[title="Settings & Tools"]').click();
    const archiveToggle = page.getByRole("button", { name: "Mostra archiviati" });
    await expect(archiveToggle).toBeVisible({ timeout: 3000 });

    // Reveal archived items
    await archiveToggle.click();
    await expect(archivedItem).toBeVisible({ timeout: 5000 });

    // Hide them again (same row)
    await archiveToggle.click();
    await expect(archivedItem).toBeHidden({ timeout: 5000 });
  });

  // AC-6: Search — now handled by command palette (Cmd+K), not inline search
  // The sidebar search button opens the command palette. Inline search tests removed
  // as the search UX changed to use the global command palette.

  // AC-8: Controls layout — search + two toggles
  test("SIDEBAR-8: sidebar controls are compact with search and toggles", async ({
    page,
  }) => {
    await goToApp(page);

    // Search launcher lives in the header (opens the ⌘K command palette).
    await expect(
      page.getByRole("button", { name: /open the command palette/ })
    ).toBeVisible({ timeout: 5000 });

    // View-mode + archive toggles live in the "Topics ▾" header menu.
    await page.locator('button[title="Settings & Tools"]').click();
    await expect(
      page.getByRole("button", { name: "Mostra archiviati" })
    ).toBeVisible({ timeout: 3000 });
    // Il toggle c'e' e nomina il modo SUCCESSIVO. Da timeline il successivo e'
    // "per stato": il modo "per tipo" e' stato rimosso il 06/08.
    await expect(
      page.getByRole("button", { name: "Vista per stato" })
    ).toBeVisible({ timeout: 3000 });
  });

  // AC-1: Clicking a topic in timeline still switches panel
  test("clicking topics in timeline switches the main panel", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "TOPIC-02",
    });

    // Pre-open standalone chat tab so it appears in sidebar
    await request.put(`${E2E_BASE}/api/ui-state/panels`, {
      data: { openPanels: [created.topics[1]] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    await openTopic(page, /E2E-StandaloneChat/);

    // Wait for textarea to confirm the panel loaded
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await expect(textarea).toBeVisible({ timeout: 10000 });
  });
});

// ── Fissati (pinning) — Arc/Dia-style pinned rows ──────────────────────────────
//
// A pinned row survives tab close (NO archive-on-close — the pinnedIds gate
// escape keeps the row), renders in the dedicated "Fissati" block at the top
// of the sidebar with a pin glyph, and one click reopens. Unpinning a CLOSED
// chat archives it (back to the 2-state model: closed ⟺ archived).
test.describe("Sidebar — Fissati (pinning)", () => {
  const BASE = E2E_BASE;
  const pinCreated: string[] = [];

  const resetSidebarState = async (request: import("@playwright/test").APIRequestContext) => {
    await request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [],
      },
    });
  };

  /** Poll the server copy of sidebar-state until `id` is (or isn't) pinned —
   *  proves the debounced PUT landed, so a reload can't lose the pin. */
  const expectServerPin = async (
    request: import("@playwright/test").APIRequestContext,
    id: string,
    present: boolean,
  ) => {
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/ui-state/sidebar-state`);
          if (!res.ok()) return !present;
          const data = await res.json();
          const pins: string[] = data?.value?.pinnedItems ?? data?.pinnedItems ?? [];
          return pins.includes(id);
        },
        { timeout: 10000 }
      )
      .toBe(present);
  };

  test.beforeAll(async ({ request }) => {
    await resetSidebarState(request);
    // Isolate from prior specs' pollution: the pane store converges by UNION on
    // hydrate, so any leftover panes / terminal sessions would surface as stray
    // tabs and make the exact tab-visibility assertions below order-dependent.
    // Start from an empty layout with no live PTYs.
    await deleteAllTerminalSessions(request);
    await resetPaneStore(request, []);
  });

  test.afterAll(async ({ request }) => {
    // Reset pins AFTER the pages closed so a late debounced PUT from the app
    // can't resurrect them into other spec files.
    await resetSidebarState(request);
    for (const id of pinCreated) await deleteTopic(request, id);
  });

  // PIN-1: il ciclo di vita completo di una chat fissata — fissa, chiudi (la
  // tessera resta), riapri dalla tessera, togli il pin.
  test("PIN-1: una chat fissata si chiude, la tessera resta, e un click la riapre", async ({
    page,
    request,
  }) => {
    const name = `E2E-PinChat-${Date.now()}`;
    const t = await createTopic(request, name);
    pinCreated.push(t.id);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const row = page.getByRole("treeitem", { name: new RegExp(name) });
    await expect(row).toBeVisible({ timeout: 10000 });

    // Pin via the topic context menu ("Fissa"). exact: true — "Fissa" is a
    // substring of "Rimuovi dai Fissati".
    await row.click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    await menu.getByRole("menuitem", { name: "Fissa", exact: true }).click();

    // Row moves into the Fissati block and carries the pinned marker.
    const pinnedSection = page.getByTestId("sidebar-pinned-section");
    await expect(pinnedSection.getByRole("treeitem", { name: new RegExp(name) })).toBeVisible({ timeout: 5000 });
    await expect(row).toHaveAttribute("data-pinned", "true");
    await expectServerPin(request, t.id, true);

    // FISSATA ⇒ SI CHIUDE LO STESSO, e la tessera resta.
    //
    // Il 03/08 la regola era l'opposto: fissata voleva dire non chiudibile
    // (`ee55a33f`). Rovesciata il 06/08 su indicazione di Attilio — «le tab
    // pinnate dovrebbero essere comunque chiudibili ma restano pinnate e quindi
    // riapribili finché non togli il pin». Il fissaggio torna una SCORCIATOIA
    // che resta, non un lucchetto da smontare per fare la cosa più comune.
    const paneTab = page.getByTestId(`pane-tab-${t.id}`);
    await expect(paneTab).toBeVisible({ timeout: 5000 });
    await paneTab.click({ button: "right" });
    await page.getByRole("button", { name: /Chiudi ora/ }).click();
    await expect(paneTab).toBeHidden({ timeout: 5000 });

    // La tessera è ancora lì — l'escape `pinnedIds` tiene la riga anche
    // archiviata — e il pin non si è mosso.
    const closedTile = pinnedSection.getByRole("treeitem", { name: new RegExp(name) });
    await expect(closedTile).toBeVisible({ timeout: 5000 });
    await expectServerPin(request, t.id, true);

    // Un click la riapre, e riaprendola si disarchivia.
    await closedTile.click();
    await expect(page.getByTestId(`pane-tab-${t.id}`)).toBeVisible({ timeout: 10000 });
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data?.topics?.[t.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(false);

    // Tolto il pin la tessera se ne va: è quello il gesto che smonta la
    // scorciatoia.
    await closedTile.click({ button: "right" });
    const menuUnpin = page.getByRole("menu");
    await menuUnpin.waitFor({ state: "visible" });
    await menuUnpin.getByRole("menuitem", { name: "Rimuovi dai Fissati" }).click();
    await expectServerPin(request, t.id, false);
    await expect(pinnedSection.getByRole("treeitem", { name: new RegExp(name) })).toHaveCount(0, { timeout: 10000 });
  });

  // La parte «un click riapre la chat archiviata» viveva in coda a questo test,
  // agganciata alla chiusura di una tab FISSATA che oggi non è più possibile.
  // Non è stata riscritta qui perché non è la stessa prova: la copre
  // `reopen-closed-tab.spec.ts`, che riapre senza passare dal fissaggio.

  // PIN-3 — una chat fissata e LASCIATA APERTA è dove l'avevi lasciata anche
  // dopo un ricarico: tab aperta, topic non archiviato, riga ancora fra i
  // Fissati.
  //
  // Storia: fino al 04/08 provava che una fissata e CHIUSA non risorgesse; poi
  // `ee55a33f` rese le fissate non chiudibili e il test fu girato su «resta
  // aperta». Dal 06/08 chiudere è di nuovo possibile (il pin è una scorciatoia,
  // non un lucchetto) — ma quello che questo test difende, cioè che un ricarico
  // non muova nulla di ciò che hai lasciato aperto, vale indipendentemente, e
  // la chiusura ha il suo test in PIN-1.
  test("PIN-3: una chat fissata lasciata aperta è dove l'avevi lasciata dopo un ricarico", async ({
    page,
    request,
  }) => {
    const name = `E2E-PinReload-${Date.now()}`;
    const t = await createTopic(request, name);
    pinCreated.push(t.id);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const row = page.getByRole("treeitem", { name: new RegExp(name) });
    await expect(row).toBeVisible({ timeout: 10000 });

    // Pin, then confirm the tab is open.
    await row.click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    await menu.getByRole("menuitem", { name: "Fissa", exact: true }).click();
    const paneTab = page.getByTestId(`pane-tab-${t.id}`);
    await expect(paneTab).toBeVisible({ timeout: 10000 });
    await expectServerPin(request, t.id, true);

    // Non la si chiude: qui si prova proprio che restando aperta il ricarico
    // non la muove. (Che chiudere sia possibile lo prova PIN-1.)

    // Ricarico: la tab è ancora aperta…
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.getByTestId(`pane-tab-${t.id}`)).toBeVisible({ timeout: 15000 });
    // …il topic NON è archiviato (nessuna chiusura è avvenuta di nascosto)…
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data?.topics?.[t.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(false);
    // …e la riga è ancora fra i Fissati. Si aspetta il marcatore sulla riga
    // stessa invece del raggruppamento, che dipende dal primo paint.
    const reloadedRow = page.getByRole("treeitem", { name: new RegExp(name) });
    await expect(reloadedRow).toBeVisible({ timeout: 15000 });
    await expect(reloadedRow).toHaveAttribute("data-pinned", "true", { timeout: 10000 });
  });

  // PIN-2: anche un PROGETTO si fissa, la sua tessera regge la chiusura della
  // tab e il ricarico, e un click ci riporta dentro.
  test("PIN-2: un progetto fissato — la tessera resta chiusa la tab, sopravvive al ricarico, e un click ci riporta", async ({
    page,
    request,
  }) => {
    const projectPath = "/tmp/e2e-pin-project";
    const name = `E2E-PinProjChat-${Date.now()}`;
    const t = await createTopic(request, name, { projectPath });
    pinCreated.push(t.id);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // The seeded project-scoped topic surfaces the project row + project tab.
    const projectBtn = page.getByTestId("project-toggle-e2e-pin-project");
    await expect(projectBtn).toBeVisible({ timeout: 10000 });

    // Pin via the project header context menu ("Fissa").
    await projectBtn.click({ button: "right" });
    await page.getByRole("button", { name: "Fissa", exact: true }).click();

    // Dentro il blocco Fissati il progetto non è più la riga con il suo
    // `project-toggle-*`: è una TESSERA. Resta un `treeitem` con lo stesso nome
    // accessibile, che è il contratto su cui questo test ha sempre poggiato —
    // «il progetto fissato si vede lì dentro» — e non la forma che aveva.
    const pinnedSection = page.getByTestId("sidebar-pinned-section");
    const pinnedTile = pinnedSection.getByRole("treeitem", { name: "e2e-pin-project" });
    await expect(pinnedTile).toBeVisible({ timeout: 5000 });
    // Pin key = the sidebar item id form (`project:<rawPath>`).
    await expectServerPin(request, `project:${projectPath}`, true);

    // Chiusa la tab, la tessera resta: è la scorciatoia, e la scorciatoia non
    // dipende dal fatto che la cosa sia aperta adesso.
    const projectPaneTab = page.getByTestId(`pane-tab-project:${encodeURIComponent(projectPath)}`);
    await expect(projectPaneTab).toBeVisible({ timeout: 5000 });
    await projectPaneTab.click({ button: "right" });
    await page.getByRole("button", { name: /Chiudi ora/ }).click();
    await expect(projectPaneTab).toBeHidden({ timeout: 5000 });
    await expect(pinnedTile).toBeVisible({ timeout: 5000 });

    // Reload — pins survive (localStorage warm-load + server hydrate).
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const reloadedTile = page
      .getByTestId("sidebar-pinned-section")
      .getByRole("treeitem", { name: "e2e-pin-project" });
    await expect(reloadedTile).toBeVisible({ timeout: 10000 });

    // Un click sulla tessera riporta alla tab del progetto.
    await reloadedTile.click();
    await expect(
      page.getByTestId(`pane-tab-project:${encodeURIComponent(projectPath)}`)
    ).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Sidebar — Project icons", () => {
  // A project row shows the REAL favicon when the folder ships one (favicon.*
  // / web manifest / index.html <link rel=icon>, resolved by GET
  // /api/projects/icon) and NOTHING otherwise — zero horizontal footprint, no
  // fake glyph, no monogram (hard product decision, Attilio 2026-07-16).
  const ICONLESS_PROJECT = "/tmp/e2e-iconless-project";
  const ICONFUL_PROJECT = "/tmp/e2e-iconful-project";
  // Smallest valid 1x1 PNG — the favicon <img> must actually decode.
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const created: string[] = [];

  test.beforeAll(async ({ request }) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(ICONLESS_PROJECT, { recursive: true });
    mkdirSync(ICONFUL_PROJECT, { recursive: true });
    writeFileSync(`${ICONFUL_PROJECT}/favicon.png`, PNG_1X1);
    // A topic bound to each path puts the dir in the icon endpoint's
    // allowlist (topic projectPaths are one of its UNION sources) and makes
    // the project row appear in the sidebar.
    for (const p of [ICONLESS_PROJECT, ICONFUL_PROJECT]) {
      const t = await createTopic(request, `E2E-Icon-${p.split("-").pop()}`, { projectPath: p });
      created.push(t.id);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    const { rmSync } = await import("node:fs");
    rmSync(ICONLESS_PROJECT, { recursive: true, force: true });
    rmSync(ICONFUL_PROJECT, { recursive: true, force: true });
  });

  test("icon-less project row renders NO icon element at all (zero footprint)", async ({ page }) => {
    await goToApp(page);
    const row = page.getByTestId("project-toggle-e2e-iconless-project");
    await expect(row).toBeVisible({ timeout: 10000 });
    // The zero-width probe <img> unmounts once the 404 settles: the row must
    // end with NO icon element — no img, no synthetic placeholder of any kind.
    await expect
      .poll(async () => row.locator('img[src*="/api/projects/icon"]').count(), { timeout: 10000 })
      .toBe(0);
    await expect(row.getByTestId("project-monogram")).toHaveCount(0);
  });

  test("project with a shipped favicon shows the real icon", async ({ page }) => {
    await goToApp(page);
    const row = page.getByTestId("project-toggle-e2e-iconful-project");
    await expect(row).toBeVisible({ timeout: 10000 });
    const icon = row.locator('img[src*="/api/projects/icon"]');
    await expect(icon).toBeVisible({ timeout: 10000 });
    // The img actually decoded (naturalWidth > 0) — a 403/404 would have
    // errored the img and swapped in the monogram instead.
    await expect
      .poll(async () => icon.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10000 })
      .toBeGreaterThan(0);
    await expect(row.getByTestId("project-monogram")).toHaveCount(0);
  });

  /**
   * ICON-CACHE — un'icona GIÀ IN CACHE deve restare VISIBILE, non solo presente.
   *
   * Il test qui sopra usa `toBeVisible()`, e questo è il suo punto cieco: per
   * Playwright «visibile» vuol dire rettangolo non vuoto e niente
   * `display:none`/`visibility:hidden` — l'**opacità non la guarda**. Passava
   * quindi anche con l'icona a `opacity: 0`, che è esattamente il difetto
   * misurato l'08/08 sul server vivo: `<img>` con `complete: true` e
   * `naturalWidth: 512`, e sullo schermo niente.
   *
   * Il meccanismo: `ProjectFavicon` accendeva l'opacità solo su `onLoad`, ma
   * un'immagine servita dalla cache è già `complete` quando React attacca il
   * gestore — quell'evento è già passato e non torna. Con la cache fredda non
   * succede mai; per questo il ricarico ripetuto è parte del test e non un
   * vezzo. In WebKit cadeva al secondo giro, in Chromium al terzo; sul telefono
   * capitava quasi sempre («da app desktop le vedo ma da PWA no… tutte, e a
   * volte tornano»).
   *
   * Si asserisce «prima o poi opaca», non «opaca subito»: il primo fotogramma a
   * 0 è legittimo (lo slot è prenotato prima che l'immagine sia disegnabile), e
   * pretendere l'istante sbagliato renderebbe rosso un comportamento giusto. Col
   * difetto in piedi l'opacità non arriva MAI a 1, quindi il rosso c'è davvero.
   */
  test("ICON-CACHE: un'icona già in cache resta opaca a ogni ricarico", async ({ page }) => {
    await goToApp(page);
    const row = page.getByTestId("project-toggle-e2e-iconful-project");
    await expect(row).toBeVisible({ timeout: 10000 });

    for (let giro = 1; giro <= 4; giro++) {
      const icon = row.locator('img[src*="/api/projects/icon"]');
      await expect(icon, `giro ${giro}: l'icona non è nel DOM`).toBeVisible({ timeout: 10000 });
      // Scaricata e decodificabile: separa «non è mai arrivata» da «è arrivata
      // e non si vede», che è il difetto sotto esame.
      await expect
        .poll(() => icon.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 10000 })
        .toBe(true);
      await expect
        .poll(() => icon.evaluate((el) => getComputedStyle(el).opacity), {
          timeout: 8000,
          message: `giro ${giro}: icona scaricata ma INVISIBILE (opacity 0) — il cancello è tornato a dipendere da onLoad`,
        })
        .toBe("1");
      // Il ricarico è ciò che scalda la cache: dal secondo giro in poi l'<img>
      // può essere completa prima che React attacchi i suoi gestori.
      if (giro < 4) {
        await page.reload();
        await expect(row).toBeVisible({ timeout: 10000 });
      }
    }
  });

  // Una tab tenuta da un'ALTRA finestra resta visibile qui, col glifo della
  // finestra: è l'unica cosa che la vecchia sezione "Finestre" sapeva fare, e
  // sopravvive alla sua rimozione (e a quella della sezione "Gruppi", che
  // ri-elencava le stesse tab con un albero parallelo).
  test("SIDEBAR-GROUPS: una tab tenuta da un'altra finestra porta il glifo, e le vecchie sezioni non ci sono più", async ({ page, request }) => {
    const topic = await createTopic(request, `SIDEBAR-ELSEWHERE-${Date.now()}`);
    // La presenza è WS-driven: si inietta un frame `presence:windows` e si
    // guarda cosa ne fa la sidebar.
    await page.routeWebSocket(/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((msg) => ws.send(msg));
      ws.onMessage((msg) => server.send(msg));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "presence:windows",
          windows: [
            {
              windowId: "e2e-other-window", clientId: "e2e-c1", windowLabel: "detach-e2e", detached: true,
              topicIds: [topic.id],
              tabs: [
                { id: topic.id, type: "chat", title: topic.name },
                { id: "terminal:e2e-cc", type: "terminal", title: "Claude Code" },
              ],
            },
          ],
        }));
      }, 1200);
    });
    await goToApp(page);

    const sidebar = page.getByTestId("sidebar-topic-list");
    await expect(
      sidebar.getByText(topic.name, { exact: false }).first(),
      "la riga della chat tenuta altrove resta nella lista",
    ).toBeVisible({ timeout: 15000 });
    await expect(
      // `data-elsewhere` e non l'`aria-label`: ancorarsi alla frase tradotta
      // CONGELAVA quella frase — non si poteva piu' riscrivere senza far rosso, e
      // quindi smetteva di essere migliorata. Vedi la tabella dei letterali
      // bloccati in CONVENTIONS.md; questa riga e' una di quelle, tolta.
      sidebar.locator("[data-elsewhere]").first(),
      "e porta il glifo della finestra che la tiene",
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.getByTestId("sidebar-windows"),
      "la vecchia sezione Finestre non c'è: una finestra è un gruppo staccato",
    ).toHaveCount(0);
    await expect(
      page.getByTestId("sidebar-groups"),
      "e nemmeno la sezione Gruppi: i gruppi stanno in fondo, e le tab sono già elencate qui",
    ).toHaveCount(0);

    await deleteTopic(request, topic.id).catch(() => {});
  });
});

/**
 * IL GRADINO FRA LE SUPERFICI È UNA COSA DA DESKTOP.
 *
 * Questa invariante viveva nella spec touch (`sidebar-touch-audit.spec.ts`,
 * SIDEBAR-CHROME-01), cioè misurata a 390×844 — l'unico posto dove NON è vera.
 * Sotto i 768px `--bg` e `--bg-surface` collassano su `--chrome-bg` (index.css,
 * `@media (max-width: 767px)`) perché lì le superfici non stanno affiancate,
 * stanno impilate a schermo pieno e se ne vede una per volta: il gradino non
 * separa niente e si legge solo come «lo sfondo è più chiaro della sidebar».
 *
 * Qui invece le superfici si vedono INSIEME — la colonna a sinistra, la pagina
 * a destra, sullo stesso schermo — e il gradino ha il suo lavoro: dire «questa
 * è la navigazione, questo è il lavoro». Quindi l'affermazione non è stata
 * cancellata col difetto che l'aveva resa falsa: è stata portata al viewport in
 * cui parla del prodotto (1280×800, il default della suite).
 *
 * Regge in ENTRAMBI i temi, e non per caso: chiaro `--chrome-bg` hsl(220 16% 93%)
 * contro `--bg` #f8f9fa, scuro hsl(224 26% 4.5%) contro hsl(222 16% 8.5%). Il
 * chrome è il più scuro dei due da tutte e due le parti.
 */
test.describe("Sidebar — le superfici, sul desktop", () => {
  test("SIDEBAR-SURFACES-01: il chrome sta un gradino SOTTO la pagina", async ({ page }) => {
    await goToApp(page);

    const chrome = await surfaceBg(page, SIDEBAR_SELECTOR);
    const pagina = await surfaceBg(page, PAGE_LAYER_SELECTOR);
    // Senza questo, due `rgba(0, 0, 0, 0)` darebbero L=0 contro L=0 e il test
    // fallirebbe per il motivo sbagliato — o, con un `<=`, passerebbe per vuoto.
    for (const [nome, valore] of [["colonna", chrome], ["pagina", pagina]] as const) {
      expect(valore, `la ${nome} non dipinge un colore opaco (${valore})`).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    }

    const lChrome = luminance(chrome);
    const lPagina = luminance(pagina);
    expect(
      lChrome,
      `chrome ${chrome} (L=${lChrome.toFixed(4)}) deve stare SOTTO la pagina ${pagina} (L=${lPagina.toFixed(4)})`,
    ).toBeLessThan(lPagina);

    // E la fascia che circonda la pagina è chrome, non pagina: `#main-content`
    // porta `bg-app-chrome` e il colore della pagina sta sul FIGLIO
    // (`.content-flip-layer`, `bg-app-bg`). È lo stesso impianto che su iPhone
    // salda la striscia sotto la tacca alla colonna.
    const fascia = await surfaceBg(page, "#main-content");
    expect(fascia, `la cornice di #main-content (${fascia}) deve essere il chrome (${chrome})`).toBe(chrome);
  });
});

test.describe("Sidebar — i due comandi in testa alla colonna", () => {
  /**
   * IL BOX SIMMETRICO NON BASTA: L'OCCHIO MISURA L'INCHIOSTRO.
   *
   * Attilio, 07/08: «il ⌘N ha la stessa distanza a destra e a sinistra? Mi
   * sembra che a destra sia un pochino più piccolo». Il box lo era — misurato,
   * `padding: 0 8px`, i due bordi esatti a 8,0 e 8,0 — ma a sinistra c'è
   * un'ICONA e a destra del TESTO, e le due cose riempiono il loro box in modo
   * diverso: un glifo lucide è disegnato dentro un riquadro da 24 col tratto da
   * 4 a 20, cioè si porta dietro ~2,3px di aria per lato a `size=14`, mentre
   * «⌘N» il suo box lo riempie quasi tutto. Somma: ~10,3 a sinistra contro
   * ~8,8 a destra. Un pixel e mezzo, e si vedeva.
   *
   * Il test misura quello che l'occhio misura — il vuoto fino all'INCHIOSTRO,
   * non fino al box — così una futura «pulizia» che rimette `px-2` simmetrico
   * torna rossa invece di tornare storta.
   */
  test("SIDEBAR-CMD-01: il vuoto a sinistra e a destra della scorciatoia è lo stesso", async ({ page }) => {
    await goToApp(page);
    const misure = await page.evaluate(() => {
      // Due terzi del box: è la proporzione di inchiostro di un glifo lucide
      // (tratto da 4 a 20 dentro un viewBox da 24).
      const INK = 16 / 24;
      const leggi = (btn: Element | null) => {
        if (!btn) return null;
        const b = btn.getBoundingClientRect();
        const svg = btn.querySelector("svg")?.getBoundingClientRect();
        const kbd = btn.querySelector("kbd")?.getBoundingClientRect();
        // NO `<kbd>` = nothing to measure, and that is not a defect: where the
        // modifier is Ctrl ("Ctrl+K" against "⌘K") the hint does not fit in the
        // row and is not drawn, while the `title` still says it on hover. This
        // symmetry is between the glyph and the shortcut: without the second,
        // the question has no subject.
        if (!svg) return null;
        if (!kbd) return "senza-scorciatoia" as const;
        const ariaGlifo = (svg.width * (1 - INK)) / 2;
        return {
          sinistra: svg.x - b.x + ariaGlifo,
          destra: b.x + b.width - (kbd.x + kbd.width),
        };
      };
      const side = document.querySelector('[aria-label="Topics sidebar"]')!;
      return {
        piu: leggi(side.querySelector('[data-testid="pane-add-menu-trigger"]')),
        cerca: leggi(side.querySelector('button[aria-label^="Search"]')),
      };
    });

    for (const [nome, m] of Object.entries(misure)) {
      expect(m, `${nome}: bottone non trovato, o senza glifo`).not.toBeNull();
      // The no-shortcut case is neither skipped nor faked: it is named, and then
      // passed over. The button WAS found — half of what this case protects —
      // and symmetry around something that is not there is not a measurement.
      if (m === "senza-scorciatoia") continue;
      expect(
        Math.abs(m!.sinistra - m!.destra),
        `${nome}: ${m!.sinistra.toFixed(2)}px di vuoto a sinistra contro ${m!.destra.toFixed(2)} a destra`,
      ).toBeLessThanOrEqual(1);
    }
  });

  /**
   * UNA CURVA SOLA PER CIÒ CHE SI TOCCA.
   *
   * Tre giri: 6 («troppo poco rotondo»), 8 («ancora non si trova col border
   * radius della finestra»), tondo («noo, non tondo»). La risposta non era il
   * raggio: quel «+» stava a 4px dall'angolo della finestra, e a quattro pixel
   * due archi si toccano e il confronto è inevitabile qualunque raggio si
   * scelga. È la DISTANZA a essere stata corretta (a 6, il passo della colonna),
   * e il raggio è tornato quello di tutte le superfici.
   *
   * Il test pretende che i comandi abbiano la STESSA curva delle righe della
   * lista: è l'invariante che i tre giri hanno cercato, e ora è scritta.
   */
  test("SIDEBAR-CMD-02: i comandi hanno la stessa curva delle righe della lista", async ({ page }) => {
    await goToApp(page);
    const raggi = await page.evaluate(() => {
      const side = document.querySelector('[aria-label="Topics sidebar"]')!;
      const r = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).borderTopLeftRadius) : -1);
      const riga = side.querySelector('[role="treeitem"]');
      return {
        piu: r(side.querySelector('[data-testid="pane-add-menu-trigger"]')),
        cerca: r(side.querySelector('button[aria-label^="Search"]')),
        riga: r(riga),
      };
    });
    expect(raggi.riga, "nessuna riga nella lista da cui prendere la curva").toBeGreaterThan(0);
    expect(raggi.piu, `il «+» ha raggio ${raggi.piu}, le righe ${raggi.riga}`).toBe(raggi.riga);
    expect(raggi.cerca, `il cerca ha raggio ${raggi.cerca}, le righe ${raggi.riga}`).toBe(raggi.riga);
  });
});
