import { test as base, type Page } from "@playwright/test";
import { openMachinePanel } from "../helpers/open-perf-panel";

/**
 * Mock data for infrastructure panel E2E tests.
 * All values are deterministic for reproducible assertions.
 */

// Here lived MOCK_CRON_JOBS, `openCronPanel` and `mockCronJobs`: the scaffold
// of the Cron panel, which left for Automazioni (HUBBR-14). Their tests moved
// to tests/e2e/automations.spec.ts, which fakes the same cron routes.

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

  async openSystemStatusPanel() {
    // TWO STEPS, because the status bar is no longer at the foot of the column:
    // it lives behind the one door of the chrome (SIDEBAR-STATUS-01), and it
    // is three rows there rather than one dense strip. Which trigger opens
    // that door (the user card on the desktop, the title on the phone) is the
    // helper's business: this fixture only knows the row it wants.
    await openMachinePanel(this.page);
    // The panel's own handle: its rows change with the status, the testid does not.
    await this.page.getByTestId("system-status-panel").waitFor({ state: "visible", timeout: 10_000 });
  }

  // --- Mock methods (call BEFORE page.goto) ---

  async mockSystemStatus(status = MOCK_SYSTEM_STATUS) {
    await this.page.route("**/api/system/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(status),
      });
    });
  }
}

export const test = base.extend<{ infraPage: InfraPage }>({
  infraPage: async ({ page }, use) => {
    await use(new InfraPage(page));
  },
});
