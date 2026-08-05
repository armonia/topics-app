import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  createTerminalSession,
  deleteTerminalSession,
  deleteAllTerminalSessions,
  resetPaneStore,
  seedPaneStore,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const created: { topics: string[]; terminals: string[] } = {
  topics: [],
  terminals: [],
};

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
      projectPath: "/tmp/e2e-sidebar-project",
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
  });

  // AC-1: Timeline view — all items in a single flat list
  test("AC-1: timeline view shows items in a single list", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
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

  // AC-1: Project accordion expands to show children — ANCORA fixme, ma la
  // motivazione scritta prima era sbagliata e la semina pure.
  //
  // Diceva: «pre-setting openPanels via API/localStorage doesn't reliably
  // propagate to React state before the click». In realtà seminava
  // `localStorage['topics-open-panels']`, una chiave MORTA: nel client la
  // nomina solo `state/pane/migration/importLegacy.ts` (la migrazione una
  // tantum), e `state/pane/bootstrap.ts` documenta che nella cartella pane
  // «no file references /api/ui-state, topics-open-panels, etc.». Si scriveva
  // in un cassetto che nessuno apre più — non era una corsa, era un no-op.
  //
  // Semina corretta (pane-store v2, come le spec stabili) messa comunque, ma
  // NON basta: il pannello del progetto compare e si apre, e il figlio
  // `E2E-ProjectChat` non viene elencato lo stesso. Lo screenshot del
  // fallimento mostra «No chats open», quindi il buco sta a monte, in come
  // `buildSidebarItems` decide i figli di un progetto — non nella semina.
  // Serve la sua analisi, tracciato nel backlog.
  test.fixme("AC-1: project accordion expands and collapses", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
    });

    const topicId = created.topics[0];
    // `/api/ui-state/panels` è l'endpoint LEGACY: la sorgente autorevole delle
    // tab aperte è il pane-store v2, ed è da lì che la sidebar decide chi
    // elencare. Si seminano entrambi.
    await seedPaneStore(request, () => ({
      panes: { [topicId]: { id: topicId, type: "chat", title: "E2E-ProjectChat", topicId } },
      groups: { "group:default": { id: "group:default", paneIds: [topicId], activePaneId: topicId, splitRatio: 1, splitAxis: "horizontal" } },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await request.put(`${E2E_BASE}/api/ui-state/panels`, {
      data: { openPanels: [topicId] },
    });

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Wait for the project to show in sidebar
    const projectBtn = page.getByTestId("project-toggle-e2e-sidebar-project");
    await expect(projectBtn).toBeVisible({ timeout: 10000 });

    // Click to expand the project accordion
    await projectBtn.click();

    // After expanding, the project chat should be visible
    await expect(
      page.getByRole("treeitem", { name: /E2E-ProjectChat/ })
    ).toBeVisible({ timeout: 10000 });
  });

  // AC-2: il toggle cicla fra le TRE viste.
  //
  // Era un test su due modi (timeline ⇄ per tipo) e falliva alla terza asserzione
  // appena la vista per STATO è entrata nel ciclo: dopo "per tipo" l'etichetta non
  // dice più "Vista timeline" ma "Vista per stato". Non è una rottura da aggirare
  // — il ciclo è cambiato di proposito (FASE 2, AC c) — quindi il test percorre
  // ora l'anello intero e verifica che si torni al punto di partenza.
  test("AC-2: view toggle cicla timeline → per tipo → per stato → timeline", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC2",
    });

    // Pre-open tabs so sections have content in grouped view
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

    // Timeline → grouped: the menu row reads "Vista per tipo".
    const groupedToggle = page.getByRole("button", { name: "Vista per tipo" });
    await expect(groupedToggle).toBeVisible({ timeout: 5000 });
    await groupedToggle.click();

    // In grouped view, collapsible section headers should appear
    await expect(
      page.getByRole("button", { name: /sezione Chat/ })
    ).toBeVisible({ timeout: 3000 });

    // L'etichetta dice il modo SUCCESSIVO: dopo "per tipo" viene "per stato".
    const statoToggle = page.getByRole("button", { name: "Vista per stato" });
    await expect(statoToggle).toBeVisible({ timeout: 3000 });
    await statoToggle.click();

    // Vista per stato: le sezioni non sono più i TIPI di pane ma gli stati, e
    // "Il resto" c'è sempre quando ci sono righe senza fase (qui nessuna sessione
    // Claude è stata seminata, quindi tutte le righe stanno lì).
    await expect(
      page.locator('[data-testid="sidebar-state-section-rest"]')
    ).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByRole("button", { name: /sezione Chat/ })
    ).toBeHidden({ timeout: 3000 });

    // Il giro si chiude: da "per stato" si torna a timeline.
    const timelineToggle = page.getByRole("button", { name: "Vista timeline" });
    await expect(timelineToggle).toBeVisible({ timeout: 3000 });
    await timelineToggle.click();

    // Timeline: nessuna sezione, né per tipo né per stato.
    await expect(
      page.getByRole("button", { name: /sezione Chat/ })
    ).toBeHidden({ timeout: 3000 });
    await expect(
      page.locator('[data-testid="sidebar-state-section-rest"]')
    ).toBeHidden({ timeout: 3000 });
  });

  // AC-3: Archive toggle shows/hides archived items
  test("AC-3: archive toggle shows and hides archived items", async ({
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
  test("AC-8: sidebar controls are compact with search and toggles", async ({
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
    await expect(
      page.getByRole("button", { name: "Vista per tipo" })
    ).toBeVisible({ timeout: 3000 });
  });

  // AC-1: Clicking a topic in timeline still switches panel
  test("clicking topics in timeline switches the main panel", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
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

  // PIN-1: full chat lifecycle — pin, close (archives; row persists via the
  // pinnedIds escape), reopen (unarchives), unpin while closed (archives).
  test("PIN-1: una chat fissata NON si chiude; tolta dai Fissati si chiude e archivia", async ({
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

    // FISSATA ⇒ NON SI CHIUDE. È la regola decisa il 03/08 («se è pinnata manco
    // posso chiuderla finché non la dis-pinno») e applicata in `ee55a33f`: la X e
    // la voce di menu spariscono, e ci passano anche tastiera e chiamanti futuri
    // perché il divieto sta in `isPaneClosable`, non nel bottone.
    //
    // Questo test chiedeva il contrario — chiudeva la tab fissata e verificava
    // che il topic si archiviasse — e descriveva un mondo che non esiste più.
    // Riscritto il 04/08 sul contratto nuovo: prima si prova che NON si chiude,
    // poi che tolta dai Fissati si chiude e archivia come qualunque altra.
    const paneTab = page.getByTestId(`pane-tab-${t.id}`);
    await expect(paneTab).toBeVisible({ timeout: 5000 });
    await paneTab.click({ button: "right" });
    await expect(page.getByRole("button", { name: /Chiudi ora/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // E la tab è ancora lì: il menu non l'ha chiusa di nascosto.
    await expect(paneTab).toBeVisible();

    // Tolta dai Fissati, torna una chat come le altre: si chiude e si archivia.
    await row.click({ button: "right" });
    const menuUnpin = page.getByRole("menu");
    await menuUnpin.waitFor({ state: "visible" });
    await menuUnpin.getByRole("menuitem", { name: "Rimuovi dai Fissati" }).click();
    await expectServerPin(request, t.id, false);

    await paneTab.click({ button: "right" });
    await page.getByRole("button", { name: /Chiudi ora/ }).click();
    await expect(paneTab).toBeHidden({ timeout: 5000 });

    // Chiusa da NON fissata, si archivia — che è il segnale «chiusa» durevole e
    // valido su tutti i client (modello a due stati). E la riga esce dai Fissati:
    // non era più fissata già prima della chiusura.
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data?.topics?.[t.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(true);
    await expect(pinnedSection.getByRole("treeitem", { name: new RegExp(name) })).toHaveCount(0);
  });

  // La parte «un click riapre la chat archiviata» viveva in coda a questo test,
  // agganciata alla chiusura di una tab FISSATA che oggi non è più possibile.
  // Non è stata riscritta qui perché non è la stessa prova: la copre
  // `reopen-closed-tab.spec.ts`, che riapre senza passare dal fissaggio.

  // PIN-3 — riscritto il 04/08, perché la sua premessa non è più raggiungibile.
  //
  // Prima verificava che una chat fissata e CHIUSA non risorgesse dopo un
  // ricarico. Da `ee55a33f` una chat fissata non si chiude affatto, quindi lo
  // stato «fissata e chiusa» non esiste: il vecchio bug è impossibile per
  // costruzione, e il test non poteva più nemmeno arrivare al punto (cadeva sul
  // «Chiudi ora» che non c'è).
  //
  // Quello che resta da difendere è lo stesso esito visto dall'utente — la chat
  // fissata è dove l'avevi lasciata — e ora si prova al contrario: dopo un
  // ricarico la tab è ANCORA APERTA, il topic NON è archiviato e la riga è
  // ancora fra i Fissati. Se qualcuno riaprisse la strada alla chiusura di una
  // tab fissata, questo test se ne accorge.
  test("PIN-3: una chat fissata resta aperta attraverso un ricarico (non si chiude, non si archivia)", async ({
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

    // La chiusura non è offerta: né la X né la voce di menu.
    await paneTab.click({ button: "right" });
    await expect(page.getByRole("button", { name: /Chiudi ora/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

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

  // PIN-2: projects are pinnable too; pins survive a reload
  test("PIN-2: pin a project → close its tab keeps the row → pins survive reload → click reopens", async ({
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

    const pinnedSection = page.getByTestId("sidebar-pinned-section");
    await expect(pinnedSection.getByTestId("project-toggle-e2e-pin-project")).toBeVisible({ timeout: 5000 });
    // Pin key = the sidebar item id form (`project:<rawPath>`).
    await expectServerPin(request, `project:${projectPath}`, true);

    // Close the project tab — the pinned row must persist.
    const projectPaneTab = page.getByTestId(`pane-tab-project:${encodeURIComponent(projectPath)}`);
    await expect(projectPaneTab).toBeVisible({ timeout: 5000 });
    await projectPaneTab.click({ button: "right" });
    await page.getByRole("button", { name: /Chiudi ora/ }).click();
    await expect(projectPaneTab).toBeHidden({ timeout: 5000 });
    await expect(pinnedSection.getByTestId("project-toggle-e2e-pin-project")).toBeVisible({ timeout: 5000 });

    // Reload — pins survive (localStorage warm-load + server hydrate).
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(
      page.getByTestId("sidebar-pinned-section").getByTestId("project-toggle-e2e-pin-project")
    ).toBeVisible({ timeout: 10000 });

    // One click reopens the project tab.
    await page.getByTestId("project-toggle-e2e-pin-project").click();
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
      sidebar.locator('[aria-label="Aperto in un\'altra finestra"]').first(),
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
