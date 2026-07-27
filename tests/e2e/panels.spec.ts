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

  test("multi-pane layout with Add Pane", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    const addPaneBtn = page.getByRole("button", { name: /Add pane/ });
    if (await addPaneBtn.count() > 0) {
      await addPaneBtn.first().click();
    }
    await expect
      .poll(
        async () => ((await page.locator('[role="main"]').textContent()) ?? "").length,
        { timeout: 10000 },
      )
      .toBeGreaterThan(10);
  });

  test("dashboard digest tab", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Activity is openclaw-gated inside the "Settings & Tools" (Topics ▾) menu.
    await mockOpenClawAvailable(page);
    await goToApp(page);
    await openTopicsMenuItem(page, "Activity");
    // Il pannello Activity e' montato quando ha del testo: si aspetta QUELLO,
    // non un tempo. Il click sul Digest non ha bisogno di una pausa dopo —
    // il passo successivo (openTopic) porta le proprie attese condizionali.
    const digestTab = page.locator("text=Digest");
    await digestTab.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    if (await digestTab.count() > 0) {
      await digestTab.first().click();
    }

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
    const remoteBtn = page.getByRole("button", { name: /Remote Access/i });
    if (await remoteBtn.count() > 0) {
      await remoteBtn.click();
      await expect
        .poll(
          async () => ((await page.locator('[role="main"]').textContent()) ?? "").length,
          { timeout: 10000 },
        )
        .toBeGreaterThan(5);
    }
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
