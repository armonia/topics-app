import { test as base, type Page } from "@playwright/test";
import { projectRow } from "../helpers/project-row";

/**
 * Deterministic mock data for browser/process E2E tests.
 */

/**
 * Gli script rilevati di un progetto, nella forma che il server manda OGGI.
 *
 * Era `Record<nome, comando>`. Dal commit 33944fa5 («Gli script di un progetto
 * vengono da tutti i manifest, non solo da package.json») l'endpoint
 * `/api/files/package-scripts` risponde `{ scripts: DetectedScript[], found,
 * looked }` — un ARRAY, perché lo stesso nome può arrivare da due manifest
 * diversi (`test` di package.json e `test` del Makefile) e serve una chiave che
 * li distingua: l'`id` è `<manifest>#<nome>`.
 *
 * Il mock nella forma vecchia non falliva un'asserzione: faceva ESPLODERE il
 * componente. `ScriptRunner` fa `scripts.some(...)` e `scriptEntries.map(...)`,
 * che su un oggetto non esistono — il render moriva e `[data-testid=
 * "script-runner"]` non compariva mai, quindi tutti e cinque i PROCESS-*
 * andavano in timeout su un pannello che non c'era.
 */
interface MockDetectedScript {
  id: string;
  name: string;
  detail: string;
  argv: string[];
  from: string;
}

const MOCK_PACKAGE_SCRIPTS: MockDetectedScript[] = [
  { id: "package.json#dev", name: "dev", detail: "vite", argv: ["npm", "run", "dev"], from: "package.json" },
  { id: "package.json#build", name: "build", detail: "vite build", argv: ["npm", "run", "build"], from: "package.json" },
  { id: "package.json#test", name: "test", detail: "vitest", argv: ["npm", "run", "test"], from: "package.json" },
  { id: "package.json#lint", name: "lint", detail: "eslint .", argv: ["npm", "run", "lint"], from: "package.json" },
];

const MOCK_RUNNING_SCRIPTS = [
  {
    processId: "p-1",
    scriptName: "dev",
    command: "vite",
    projectPath: "/mock/project",
    status: "running" as const,
    pid: 12345,
    startedAt: "2026-03-31T10:00:00Z",
    ports: [5173],
  },
];

const MOCK_BROWSER_CONTEXTS = [
  {
    id: "ctx-1",
    url: "https://example.com/page",
    title: "Example Page",
    lastActivity: Date.now() - 60000,
  },
  {
    id: "ctx-2",
    url: "https://docs.test/guide",
    title: "Docs Guide",
    lastActivity: Date.now() - 120000,
  },
];

export class BrowserProcessPage {
  // Phase 30 BROWSER-CHAT-02: promoted to `protected` so BrowserProcessPageV2
  // (extends this class) can call this.page.routeWebSocket / page.route directly
  // for the new WS bridge + tool-agent mocks. Tests in this fixture's own file
  // continue to use `this.page` exactly as before.
  constructor(protected page: Page) {}

  // ── Script Runner Mocks ──

  /**
   * Mock all ScriptRunner API endpoints. Call BEFORE page.goto().
   * Also mocks file-related APIs used by ProjectSidebar to prevent real requests.
   */
  async mockScriptRunner(
    scripts: MockDetectedScript[] = MOCK_PACKAGE_SCRIPTS,
    running: typeof MOCK_RUNNING_SCRIPTS = [],
  ) {
    await this.page.route("**/files/package-scripts*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        // `found`/`looked` fanno parte della risposta vera (server/routes/files.ts):
        // dicono quali manifest sono stati trovati e quali sono stati cercati. Il
        // mock li porta perché la forma sia quella del server, non una sua metà.
        body: JSON.stringify({ scripts, found: ["package.json"], looked: ["package.json"] }),
      });
    });

    // Mock /scripts endpoint (GET only — list running scripts)
    await this.page.route("**/scripts", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ scripts: running }),
        });
      } else {
        await route.fallback();
      }
    });

    await this.page.route("**/scripts/run", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          processId: "p-new",
          scriptName: "dev",
          pid: 99999,
          startedAt: new Date().toISOString(),
        }),
      });
    });

    await this.page.route("**/scripts/*/stop", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // Mock file listing for project sidebar (prevents real file system reads)
    await this.page.route("**/api/files*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ files: [] }),
      });
    });

    // Mock git status for project sidebar
    await this.page.route("**/api/git/status*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ files: [], branch: "main", ahead: 0, behind: 0 }),
      });
    });
  }

  // ── Browser Sidebar Mocks ──

  /**
   * Mock BrowserSidebarControl API endpoints. Call BEFORE page.goto().
   */
  async mockBrowserContexts(
    contexts: typeof MOCK_BROWSER_CONTEXTS = MOCK_BROWSER_CONTEXTS,
  ) {
    await this.page.route("**/api/browser/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ details: contexts }),
      });
    });

    await this.page.route("**/api/browsers/*", async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });
  }

  // ── Remote Browser Panel Mocks ──

  /**
   * Mock RemoteBrowserPanel / useRemoteBrowser API endpoints. Call BEFORE page.goto().
   * This stubs the info, snapshot, and interact endpoints.
   */
  async mockRemoteBrowserPane(opts?: {
    connected?: boolean;
    url?: string;
    title?: string;
    hasScreenshot?: boolean;
  }) {
    const connected = opts?.connected ?? false;
    const url = opts?.url ?? "";
    const title = opts?.title ?? "";

    // GET /api/browsers/:id — info endpoint (match paths with exactly one segment after /browsers/)
    await this.page.route(/\/api\/browsers\/[^/]+$/, async (route) => {
      if (route.request().method() === "GET") {
        if (connected) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ url, title, connected: true }),
          });
        } else {
          await route.fulfill({ status: 404, body: "Not found" });
        }
      } else if (route.request().method() === "DELETE") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });

    // POST /api/browsers/:id/interact
    await this.page.route("**/api/browsers/*/interact", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // GET /api/browsers/:id/snapshot — screenshot endpoint
    await this.page.route("**/api/browsers/*/snapshot*", async (route) => {
      if (opts?.hasScreenshot) {
        // Return a tiny 1x1 PNG
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        );
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: png,
        });
      } else {
        await route.fulfill({ status: 404, body: "No screenshot" });
      }
    });
  }

  // ── Navigation Helpers ──

  /**
   * Open a project topic via the sezione Progetti, then expand Processes.
   * Project topics appear in the "Projects" sidebar section, not in Chats treeitems.
   *
   * L'intestazione della sezione si cercava per testo — `button:has-text("Processes")`.
   * Non regge più due cambiamenti del prodotto, entrambi già in HEAD:
   *  - 9d1991ea («Multilingua: terzo lotto…») ha tradotto l'etichetta
   *    (`tr('project.sidebar.processes')`); la suite gira con `locale: "it-IT"`
   *    (playwright.config.ts), quindi a schermo c'è scritto «Processi».
   *  - a3a2a614 / 3218af47 hanno ridisegnato la barra CHIUSA come una rail di
   *    sole icone: lì l'intestazione non esiste proprio nel DOM.
   * L'ancora è ora `data-testid="project-sidebar-processes"`, aggiunto in
   * ProjectSidebar.tsx su entrambe le varianti (desktop e mobile).
   */
  async openProjectAndProcesses(projectNamePattern: RegExp) {
    // Expand sezione Progetti if collapsed
    const projectsSection = this.page.getByRole("button", { name: /sezione Progetti/ });
    if (await projectsSection.count() > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
      }
    }

    // Click the project folder button in the sidebar.
    //
    // `projectRow` e non «il primo bottone della colonna che contenga quel
    // testo»: quella forma identifica una riga dal TESTO che porta, e il testo
    // di un progetto compare in più posti (la riga della board elenca i
    // progetti con task aperti). Sette spec ci sono già cadute il 07/08 —
    // `.first()` prendeva la riga sbagliata e il rosso arrivava dieci secondi
    // dopo, su un componente che non c'entrava. Vedi `helpers/project-row`.
    const projectBtn = projectRow(this.page, projectNamePattern);
    await projectBtn.waitFor({ state: "visible", timeout: 10000 });
    await projectBtn.click();

    // Wait for project pane to appear (the ProjectSidebar with Processes section)
    await this.page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });

    // La barra di progetto può essere CHIUSA: in quel modo (a3a2a614) è una rail
    // di 40px con sole icone, e l'intestazione «Processi» non è nel DOM. Prima la
    // si riapre dal suo unico bottone d'header, poi si procede come sopra.
    const rail = this.page.locator('[data-testid="project-sidebar-rail"]');
    if (await rail.count() > 0) {
      await this.page.locator('[data-testid="project-sidebar-rail-header"] button').click();
    }

    // Apri la sezione Processi. Locator STRICT, senza `.first()`: due
    // ProjectSidebar montate insieme sono il guaio descritto in
    // browser-process.spec.ts (pane-store condiviso), e `scriptRunner` qui sotto
    // è già strict — mascherarlo qui sposterebbe solo il rosso più in là.
    // `aria-expanded` perché il bottone è un toggle: cliccarlo alla cieca su una
    // sezione già aperta la RICHIUDEREBBE.
    const processesBtn = this.page.locator('[data-testid="project-sidebar-processes"]');
    await processesBtn.waitFor({ state: "visible", timeout: 10000 });
    if ((await processesBtn.getAttribute("aria-expanded")) !== "true") {
      await processesBtn.click();
    }

    // Wait for script-runner to appear
    await this.page.locator('[data-testid="script-runner"]').waitFor({ state: "visible", timeout: 10000 });
  }

  /**
   * Expand the Browser sidebar section.
   */
  async expandBrowserSection() {
    const browserBtn = this.page.getByRole("button", { name: "sezione Browser" });
    await browserBtn.waitFor({ state: "visible", timeout: 10000 });
    const isExpanded = await browserBtn.getAttribute("aria-expanded");
    if (isExpanded !== "true") {
      await browserBtn.click();
    }
    // Wait for browser sidebar content to render (BrowserSidebarControl root div.pb-2)
    await this.page.locator('.pb-2 .px-2').first().waitFor({ state: "visible", timeout: 10000 });
  }

  /**
   * Open a browser pane via the Settings & Tools dropdown menu.
   */
  async openBrowserPaneViaMenu() {
    const settingsBtn = this.page.locator('button[title="Settings & Tools"]');
    await settingsBtn.click();
    const browserItem = this.page.locator('button:has-text("Browser"):visible');
    await browserItem.click();
  }

  // ── Locators ──

  get scriptRunner() {
    return this.page.locator('[data-testid="script-runner"]');
  }

  get browserSectionButton() {
    return this.page.getByRole("button", { name: "sezione Browser" });
  }

  get urlInput() {
    // Stable testid — the visible placeholder is localized ("Cerca o inserisci
    // un indirizzo"), so match the data-testid the toolbar input always carries.
    return this.page.locator('[data-testid="browser-url-input"]');
  }
}

// Export mock data for direct use in tests
export { MOCK_PACKAGE_SCRIPTS, MOCK_RUNNING_SCRIPTS, MOCK_BROWSER_CONTEXTS };

export const test = base.extend<{ browserProcessPage: BrowserProcessPage }>({
  browserProcessPage: async ({ page }, use) => {
    await use(new BrowserProcessPage(page));
  },
});
