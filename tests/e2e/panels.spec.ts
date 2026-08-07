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
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE_URL = E2E_BASE;
const PROJECT_DIR = "/tmp/e2e-panels";
const PROJECT_FILE = "e2e-marker.txt";

// Full sidebar-state payload — every legacy field is included so the server's
// migration path (which fires when viewMode is absent) can't reset viewMode.
function sidebarState(viewMode: "timeline" | "state") {
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

/** Restore the default timeline view so later tests aren't left in another mode. */
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

  // Qui c'era "terminal section exists": verificava che la riga di un terminale
  // finisse sotto l'intestazione «sezione Terminali» del modo PER TIPO, rimosso
  // il 06/08 (Attilio). Il soggetto del test non esiste più, quindi resta la
  // parte che è ancora una verità: quelle intestazioni non si disegnano più in
  // nessuna vista.
  //
  // NOTA, trovata riscrivendolo e non inseguita: seminando la pane di un
  // terminale (`resetPaneStore`) — e anche mettendola in `openPanels` — la sua
  // riga NON compare nella sidebar. Il vecchio test non se ne accorgeva perché
  // guardava l'intestazione della sezione, non la riga. È una domanda a sé
  // (roster delle sessioni? gate di visibilità?) in un'area che un'altra
  // sessione sta riscrivendo, e va guardata con quel contesto in mano.
  test("le intestazioni per TIPO non esistono in nessuna vista", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    const session = await createTerminalSession(request, { name: "E2E-PanelTerm" });
    await resetPaneStore(request, [`terminal:${session.id}`]);
    try {
      await goToApp(page);
      for (const label of ["Terminali", "Browser", "Chat", "Progetti", "Strumenti"]) {
        await expect(
          page.getByRole("button", { name: `sezione ${label}` }),
          `nessuna sezione «${label}»`,
        ).toHaveCount(0);
      }
    } finally {
      await deleteTerminalSession(request, session.id);
      await resetPaneStore(request, []);
      await resetTimelineView(request);
    }
  });

  test("browser section shows instances", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Come sopra: la "sezione Browser" era del modo per tipo. La riga di un
    // browser viene emessa per ogni pane `browser:` aperta
    // (buildSidebarItems:512 — non serve un contesto vivo), ed e' quella la
    // cosa da difendere.
    await resetPaneStore(request, ["browser:e2e-panel-browser"]);
    try {
      await goToApp(page);
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

  // Il test «remote access panel opens» stava qui e se n'è andato col pannello.
  // Il prodotto è stato cancellato in `005c93e5` e il requisito RITIRATO in
  // `ce456581` (`openspec/changes/device-auth/specs/remote-access/spec-removal.md`,
  // sezione «REMOVED Requirements»): non c'è più una riga «Remote Access» nel menu
  // Topics ▾ da aprire. Il commento che il test portava — «se manca, deve
  // fallire» — ha fatto esattamente il suo lavoro: è mancata, e ha fallito.

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
    await expect(main.getByText("File", { exact: true }).first()).toBeVisible({ timeout: 10000 });
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
    // Che Escape CHIUDA e' l'unica cosa che questa riga verifica, ed era annullata
    // da un `.catch(() => {})`: con quello attaccato l'asserzione non poteva
    // fallire, quindi il test restava verde anche se Escape non faceva nulla.
    await expect(dialog.first()).toBeHidden({ timeout: 3000 });
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
