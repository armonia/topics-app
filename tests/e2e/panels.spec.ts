import { test, expect, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
  createTerminalSession,
  deleteTerminalSession,
  resetPaneStore,
} from "./helpers/api-fixtures";
import { mockOpenClawAvailable, openTopicsMenuItem } from "./helpers/openclaw";

const BASE_URL = "http://localhost:13334";
const PROJECT_DIR = "/tmp/e2e-panels";
const PROJECT_FILE = "e2e-marker.txt";

// Full sidebar-state payload — every legacy field is included so the server's
// migration path (which fires when viewMode is absent) can't reset viewMode.
function sidebarState(viewMode: "timeline" | "grouped") {
  return {
    viewMode,
    showArchived: false,
    expandedNodes: [],
    pinnedItems: [],
    showProjects: true,
    showChats: true,
    showTerminals: true,
    showProjectsArchived: false,
    showChatsArchived: false,
    browserExpanded: false,
  };
}

/** Persist grouped view on the SERVER (wins over localStorage on mount). */
async function setGroupedView(request: APIRequestContext): Promise<void> {
  await request.put(`${BASE_URL}/api/ui-state/sidebar-state`, { data: sidebarState("grouped") });
}

/** Restore the default timeline view so later tests aren't left in grouped mode. */
async function resetTimelineView(request: APIRequestContext): Promise<void> {
  await request.put(`${BASE_URL}/api/ui-state/sidebar-state`, { data: sidebarState("timeline") });
}

let projectTopicId: string | null = null;

test.describe("Panels & Views", () => {
  test.beforeAll(async ({ request }) => {
    // La cartella del progetto deve ESISTERE sul disco: il file explorer legge
    // il FS vero e senza di essa rende "directory not found" — cioe' il test si
    // reggeva su un pannello vuoto. Un file dentro gli da' qualcosa da mostrare.
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(`${PROJECT_DIR}/${PROJECT_FILE}`, "seed\n");
    // Create a project-linked topic so the "Projects" section has an entry
    const topic = await createTopic(request, "E2E-PanelProject", {
      projectPath: PROJECT_DIR,
    });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) {
      await deleteTopic(request, projectTopicId);
    }
  });

  test("activity feed shows Live/Digest tabs", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Activity is openclaw-gated inside the "Settings & Tools" (Topics ▾) menu.
    await mockOpenClawAvailable(page);
    await goToApp(page);
    await openTopicsMenuItem(page, "Activity");
    // Niente networkidle: lo stream SSE dell'activity tiene la connessione
    // aperta per sempre. Ma nemmeno una pausa fissa: si POLLA la condizione
    // finale, che ritorna appena il pannello ha renderizzato invece di pagare
    // sempre il caso peggiore (ed e' piu' forte — se non arriva mai, fallisce
    // dicendo cosa aspettava, invece di un opaco "length > 5").
    await expect
      .poll(
        async () => /Live|Digest|Activity|heartbeat/.test(
          (await page.locator('[role="main"]').textContent()) ?? "",
        ),
        { timeout: 10000 },
      )
      .toBe(true);
  });

  test("agents panel shows content", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Agents is openclaw-gated inside the "Settings & Tools" (Topics ▾) menu.
    await mockOpenClawAvailable(page);
    await goToApp(page);
    await openTopicsMenuItem(page, /Agents/);
    await expect
      .poll(
        async () => ((await page.locator('[role="main"]').textContent()) ?? "").length,
        { timeout: 10000 },
      )
      .toBeGreaterThan(5);
  });

  test("multi-pane layout with Add Pane", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Il "+" NON e' condizionale, e la vecchia forma `if (count > 0)` rendeva
    // il test verde anche se spariva del tutto. Catena dal sorgente:
    //   StandaloneChatGroup.tsx:525 → availableTypes =
    //     getAddableTypesForScope('standalone', …), che restituisce SEMPRE
    //     almeno browser + terminal (paneConfig.ts:46-47: entrambi hanno
    //     addableScopes ['standalone','project'] e NON sono singleton, quindi
    //     nessun filtro puo' svuotare la lista);
    //   PaneTabBar.tsx:590 → hasMenuItems = onNewChat || availableTypes.length
    //     > 0 → vero; PaneTabBar.tsx:966 monta <PaneAddMenu …>;
    //   PaneAddMenu.tsx:374+467-474 → il trigger ha title={triggerTitle} col
    //     default "Add pane" (PaneTabBar non lo sovrascrive: l'header di App
    //     usa "New (⌘N)" e la sidebar "Add to project", quindi questo title
    //     identifica UNA sola affordance).
    // Nessun feature-flag, nessun gate openclaw, nessun ramo desktop-only,
    // nessuna fetch di mezzo: l'asserzione va incondizionata.
    //
    // Pane-store azzerato prima di caricare: con un layout ereditato dagli
    // spec precedenti esisterebbero piu' celle — quindi piu' tab bar e piu'
    // "+" — e il test non saprebbe piu' quale sta guardando.
    await resetPaneStore(request, []);
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    const addPaneBtn = page.getByTitle("Add pane");
    await expect(addPaneBtn).toBeVisible({ timeout: 10000 });
    await addPaneBtn.click();

    // Il menu e' portalato su document.body (PaneAddMenu.tsx:525): si asserisce
    // sul suo testid stabile e sulle voci che lo scope standalone offre sempre
    // (Shell = terminal, PaneAddMenu.tsx:223; Browser, PaneAddMenu.tsx:286).
    const addMenu = page.getByTestId("pane-add-menu");
    await expect(addMenu).toBeVisible({ timeout: 5000 });
    await expect(addMenu.getByTestId("pane-add-menu-shell")).toBeVisible();
    await expect(addMenu.getByTestId("pane-add-menu-browser")).toBeVisible();

    // Ci si ferma al menu SENZA creare davvero il pannello: la creazione vera
    // lascerebbe un PTY / una sessione browser viva in una suite seriale e non
    // ermetica, ed e' gia' coperta altrove — browser-add-empty.spec.ts (scope
    // standalone) e layout-navigation.spec.ts, test "LAYOUT-04" (scope
    // progetto: apre il menu e clicca davvero la prima voce).
    await page.keyboard.press("Escape");
    await expect(addMenu).toBeHidden({ timeout: 5000 });
  });

  test("dashboard digest tab", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Il tab "Digest" NON e' condizionale: ActivityFeedPanel.tsx:83-95 mappa
    // `['live','digest']` senza guardie — se il pannello e' montato, i due
    // bottoni ci sono entrambi. Quindi il vecchio
    // `waitFor(...).catch(() => {})` + `if (count > 0)` non proteggeva da
    // nulla: assorbiva il caso "il pannello non e' montato affatto" e faceva
    // passare il test senza mai cliccare il Digest.
    //
    // Reset del pane-store: e' la causa sospetta del rosso in run completa
    // (verde 10/10 in isolamento). handleOpenAsPage registra il pane utility
    // in `group:default` e lo mette a fuoco (usePanelLifecycle.ts:895-915), ma
    // su un layout ereditato dagli altri spec — split, celle, tab di fondo —
    // il pane Activity puo' finire in una cella non visibile, e piu' avanti la
    // chat riaperta non diventa il tab attivo della cella a schermo: la
    // "Message input" non compare mai. Da zero la sequenza e' deterministica.
    await resetPaneStore(request, []);
    // Activity is openclaw-gated inside the "Settings & Tools" (Topics ▾) menu.
    await mockOpenClawAvailable(page);
    await goToApp(page);
    await openTopicsMenuItem(page, "Activity");

    // Si aspetta il pannello VERO (data-testid su ActivityFeedPanel.tsx:80),
    // non un testo qualsiasi dentro main — "Activity" e' anche l'etichetta del
    // tab, quindi cercarla nel testo non distingue "pannello montato" da
    // "solo la linguetta aperta".
    const activityFeed = page.getByTestId("activity-feed");
    await expect(activityFeed).toBeVisible({ timeout: 10000 });

    const digestTab = activityFeed.getByRole("button", { name: "Digest", exact: true });
    await expect(digestTab).toBeVisible({ timeout: 10000 });
    await digestTab.click();

    // Il click deve MONTARE il JournalPanel (import lazy dietro <Suspense>,
    // ActivityFeedPanel.tsx:98-103). Il testid sta sul div radice
    // (JournalPanel.tsx:77) e non dipende dall'esito della fetch del journal:
    // errore o giornata vuota rendono comunque il pannello.
    await expect(page.getByTestId("journal-panel")).toBeVisible({ timeout: 10000 });

    // Navigate back to chat and wait for input to be ready
    await openTopic(page, /Web Search Test/);
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
  });

  test("terminal section exists", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Sidebar sections (Terminali/Browser/…) only render in GROUPED view; the
    // default is the unified timeline. viewMode is SERVER-persisted
    // (useSidebarState fetches /api/ui-state/sidebar-state on mount and it wins
    // over localStorage), so a localStorage-only seed is clobbered — set it on
    // the server, including all legacy fields to block the migration path.
    await setGroupedView(request);
    // A grouped section renders only when it has ≥1 item (TopicTree:724 hides
    // empty sections), and a standalone terminal shows only with an OPEN tab
    // (buildSidebarItems §4). Seed a real session AND its pane so the Terminals
    // section has content.
    const session = await createTerminalSession(request, { name: "E2E-PanelTerm" });
    await resetPaneStore(request, [`terminal:${session.id}`]);
    try {
      await goToApp(page);
      // Accessible name is `sezione <label>` (TopicTree renderSection) and the
      // labels are Italian since ed903cfc — match it exactly, not by a loose
      // substring that a rename can silently stop matching.
      const terminalsBtn = page.getByRole("button", { name: "sezione Terminali" });
      await expect(terminalsBtn).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteTerminalSession(request, session.id);
      await resetPaneStore(request, []);
      await resetTimelineView(request);
    }
  });

  test("browser section shows instances", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Sidebar sections only render in GROUPED view (default is timeline) and
    // only when non-empty. A browser row is emitted for every open `browser:`
    // pane (buildSidebarItems:512 — no live context required), so seeding a
    // browser pane populates the sezione Browser. viewMode is server-persisted,
    // so grouped mode must be set on the server (see terminal test above).
    await setGroupedView(request);
    await resetPaneStore(request, ["browser:e2e-panel-browser"]);
    try {
      await goToApp(page);
      const browserSection = page.getByRole("button", { name: "sezione Browser" });
      await expect(browserSection.first()).toBeVisible({ timeout: 10000 });

      await browserSection.first().click();
      await expect
        .poll(
          async () => /[Bb]rowser/.test((await page.locator("body").textContent()) ?? ""),
          { timeout: 10000 },
        )
        .toBe(true);
    } finally {
      await resetPaneStore(request, []);
      await resetTimelineView(request);
    }
  });

  test("remote access panel opens", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    // "Remote Access" NON e' piu' un bottone dell'header: e' una riga del menu
    // "Settings & Tools" (Topics ▾) — App.tsx:1238-1244, vedi la nota a
    // App.tsx:931 "Activity / Agents / Remote Access moved into the Topics ▾
    // menu". Il vecchio corpo lo cercava a MENU CHIUSO: `count()` era 0, il
    // blocco non veniva mai eseguito e il test restava verde senza aprire
    // niente. Si apre con l'helper condiviso, come Activity e Agents.
    //
    // A differenza di Activity/Agents la riga NON e' dietro
    // `openclawAvailable` (quelle sono avvolte in `{openclawAvailable && …}`,
    // App.tsx:1245 e 1254; questa no) e non ha rami isMobile: e' sempre
    // presente, quindi nessuno skip condizionale — se manca, deve fallire.
    await openTopicsMenuItem(page, /Remote Access/i);

    // Il pannello e' portalato su document.body (App.tsx:1297-1319), NON
    // dentro [role="main"]: la vecchia asserzione sul testo di main non lo
    // avrebbe visto nemmeno cliccando.
    //
    // Si asserisce sul toggle del tunnel, l'unico elemento che RemoteAccessPanel
    // rende in ENTRAMBI i rami di stato e che appartiene solo a lui:
    // "Disable Tunnel" se /api/remote/status riporta un tunnel attivo
    // (RemoteAccessPanel.tsx:144), "Enable Tailscale Funnel" altrimenti — e
    // "altrimenti" include fetch fallita/errore, perche' `status` resta null e
    // il componente cade comunque nel ramo inattivo (RemoteAccessPanel.tsx:92
    // e 166). Nessuna dipendenza dall'esito della chiamata, quindi.
    const tunnelToggle = page.getByRole("button", {
      name: /Enable Tailscale Funnel|Disable Tunnel/,
    });
    await expect(tunnelToggle).toBeVisible({ timeout: 10000 });
  });

  test("opening a project shows its file explorer", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Il nome vecchio era "file explorer opens project topics" e il corpo cercava
    // un getByRole("treeitem") con "E2E-PanelProject" NELLA SIDEBAR. Non esiste:
    // cliccare il progetto apre la FINESTRA progetto, e le sue chat sono tab
    // dentro quella finestra, non treeitem della sidebar. La ricerca scadeva
    // sempre (10s) e il catch la ingoiava, cadendo su un fallback che apriva
    // "Web Search Test" — cioe' il test verde non ha mai verificato un progetto.
    // Ora asserisce cio' che il click produce davvero, ed e' 10s piu' veloce.
    if (projectTopicId) await resetPaneStore(request, [projectTopicId]);
    await goToApp(page);
    // Use the project-linked topic we created (folder name = "e2e-panels")
    const projectBtn = page.locator('button:has-text("e2e-panels")').first();
    await expect(projectBtn).toBeVisible({ timeout: 10000 });
    await projectBtn.click();

    // La finestra progetto e' aperta quando rende il suo file explorer sul
    // contenuto REALE della cartella: il file seminato in beforeAll.
    const main = page.locator('[role="main"]');
    await expect(main.getByText("Files", { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(main.getByText(PROJECT_FILE).first()).toBeVisible({ timeout: 10000 });
    await expect(main).not.toContainText("directory not found");
  });

  test("command palette opens with Cmd+K", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Ensure app is ready before triggering shortcut
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Meta+k");

    // Wait for dialog/palette to appear
    const dialog = page.locator('[role="dialog"], [class*="CommandPalette"], [class*="command-palette"], [class*="modal"]');
    await expect(dialog.first()).toBeVisible({ timeout: 5000 });

    const searchInput = page.locator('[role="dialog"] input, [class*="modal"] input');
    if (await searchInput.count() > 0) {
      await searchInput.first().fill("new");
    }

    await page.keyboard.press("Escape");
    // Wait for dialog to close
    await expect(dialog.first()).toBeHidden({ timeout: 3000 }).catch(() => {});
  });

  test("scripts API responds", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    const ok = await page.evaluate(async () => {
      const res = await fetch("/api/scripts");
      return res.ok;
    });
    expect(ok).toBeTruthy();
  });
});
