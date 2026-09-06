import { test as base, type Page } from "@playwright/test";
import { mockOpenClawAvailable, openAddMenuPane } from "../helpers/openclaw";
import { openPerfPanel } from "../helpers/open-perf-panel";

/**
 * Mock data for infrastructure panel E2E tests.
 * All values are deterministic for reproducible assertions.
 */

export const MOCK_CRON_JOBS = [
  {
    id: "cron-1",
    name: "Daily backup",
    enabled: true,
    schedule: { kind: "every" as const, everyMs: 3600000 },
    payload: { kind: "systemEvent" as const, text: "backup:run" },
    sessionTarget: "main" as const,
    nextRunAt: new Date(Date.now() + 1800000).toISOString(),
    lastRunAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: "cron-2",
    name: "Nightly sync",
    enabled: true,
    schedule: { kind: "cron" as const, expr: "0 2 * * *" },
    payload: { kind: "agentTurn" as const, message: "Run nightly sync" },
    sessionTarget: "isolated" as const,
    nextRunAt: new Date(Date.now() + 7200000).toISOString(),
  },
  {
    id: "cron-3",
    name: "One-time task",
    enabled: false,
    schedule: { kind: "at" as const, atMs: Date.now() + 86400000 },
    payload: { kind: "systemEvent" as const, text: "cleanup:stale" },
    sessionTarget: "main" as const,
  },
];

// Qui vivevano MOCK_TUNNEL_ACTIVE/INACTIVE, `openRemoteAccessPanel` e
// `mockRemoteStatus`: l'impalcatura del pannello «Accesso remoto», cancellato in
// `005c93e5` e con il requisito ritirato in `ce456581`
// (`openspec/changes/device-auth/specs/remote-access/spec-removal.md`). Senza
// chiamanti erano finti appigli: il prossimo che ne avesse trovato uno avrebbe
// scritto un test su una superficie che non esiste.

export const MOCK_SYSTEM_STATUS = {
  timestamp: new Date().toISOString(),
  gateway: {
    online: true,
    status: "online" as const,
    latencyMs: 42,
    httpStatus: 200,
    lastCheckedAt: new Date(Date.now() - 5000).toISOString(),
  },
  server: {
    uptimeMs: 120000,
    startedAt: new Date(Date.now() - 120000).toISOString(),
    memoryMB: 256,
    heapUsedMB: 180,
    heapTotalMB: 350,
  },
  connections: {
    wsClients: 2,
    activeStreams: 1,
    streamKeys: ["stream-1"],
  },
  topics: {
    activeCount: 5,
    totalCount: 12,
  },
  cronJobs: {
    enabled: 2,
    disabled: 1,
    total: 3,
    nextRun: new Date(Date.now() + 1800000).toISOString(),
  },
  sessions: {
    total: 4,
    byType: { chat: 3, agent: 1 },
  },
};

export class InfraPage {
  constructor(private page: Page) {}

  // --- Navigation helpers ---

  async openCronPanel() {
    // «Cron Jobs» stava nel dropdown «Settings & Tools»; ora è la riga «Cron»
    // del menu «New» (⌘N), col nome che la pane porta davvero. Resta gated su
    // `openclawAvailable` — il gate è passato dal `.filter` del dropdown a
    // `PaneConfig.requires`, quindi senza lo stub di `mockCronJobs` la riga non
    // compare in NESSUN menu. Aperta la pane, si aspetta il suo «Refresh».
    await openAddMenuPane(this.page, "cron");
    await this.page
      .getByRole("button", { name: "Refresh" })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  async openSystemStatusPanel() {
    // TWO STEPS, because the status bar is no longer at the foot of the column:
    // it lives behind the one door of the chrome (SIDEBAR-STATUS-01), and it
    // is three rows there rather than one dense strip. Which trigger opens
    // that door (the user card on the desktop, the title on the phone) is the
    // helper's business: this fixture only knows the row it wants.
    await openPerfPanel(this.page);
    await this.page
      .locator("text=Gateway")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  // --- Mock methods (call BEFORE page.goto) ---

  async mockCronJobs(jobs = MOCK_CRON_JOBS) {
    let currentJobs = [...jobs];

    // The Cron Jobs menu entry is OpenClaw-gated.
    await mockOpenClawAvailable(this.page);

    await this.page.route("**/api/cron/jobs", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jobs: currentJobs }),
        });
      } else {
        await route.fallback();
      }
    });

    await this.page.route("**/api/cron/jobs/*/run", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });

    await this.page.route("**/api/cron/jobs/*", async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      // Skip /run endpoint (handled above)
      if (url.includes("/run")) {
        await route.fallback();
        return;
      }

      if (method === "PATCH") {
        const body = route.request().postDataJSON();
        const id = url.split("/").pop();
        currentJobs = currentJobs.map((j) =>
          j.id === id ? { ...j, ...body } : j
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else if (method === "DELETE") {
        const id = url.split("/").pop();
        currentJobs = currentJobs.filter((j) => j.id !== id);
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

  async mockSystemStatus(status = MOCK_SYSTEM_STATUS) {
    // SystemStatusPanel gates its Gateway, Cron Jobs and Restart rows behind
    // openclawAvailable (they're OpenClaw-only). A meaningful "system status"
    // is the OpenClaw-connected state, so enable it here — otherwise the panel
    // renders only Server/Tab aperti/Archiviati and the gated rows never mount.
    await mockOpenClawAvailable(this.page);
    await this.page.route("**/api/system/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(status),
      });
    });
  }

  async mockOpenclawRestart() {
    await this.page.route("**/api/openclaw/restart", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
  }
}

export const test = base.extend<{ infraPage: InfraPage }>({
  infraPage: async ({ page }, use) => {
    await use(new InfraPage(page));
  },
});
