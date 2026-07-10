import { test as base, type Page } from "@playwright/test";
import { mockOpenClawAvailable, openTopicsMenuItem } from "../helpers/openclaw";

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

export const MOCK_WEBHOOKS = [
  {
    id: "wh-1",
    name: "Deploy Hook",
    url: "https://hooks.example.com/deploy",
    secret: "whsec_abc123",
    events: ["topic.created", "topic.updated", "chat.message"],
    active: true,
    retryCount: 3,
    timeoutMs: 5000,
    createdAt: "2026-03-20T10:00:00Z",
    updatedAt: "2026-03-25T14:30:00Z",
  },
  {
    id: "wh-2",
    name: "Audit Logger",
    url: "https://audit.example.com/log",
    secret: "whsec_def456",
    events: [],
    active: false,
    retryCount: 1,
    timeoutMs: 3000,
    createdAt: "2026-03-22T08:00:00Z",
    updatedAt: "2026-03-22T08:00:00Z",
  },
];

export const MOCK_TUNNEL_ACTIVE = {
  active: true,
  url: "https://test.ts.net",
  type: "tailscale" as const,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};

export const MOCK_TUNNEL_INACTIVE = {
  active: false,
  type: "tailscale" as const,
};

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
    // Cron Jobs moved into the "Settings & Tools" (Topics ▾) menu and is gated
    // on `openclawAvailable` (stubbed in mockCronJobs). Open via the menu, then
    // wait for the pane's "Refresh" button.
    await openTopicsMenuItem(this.page, "Cron Jobs");
    await this.page
      .getByRole("button", { name: "Refresh" })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  async openRemoteAccessPanel() {
    // Remote Access is a "Settings & Tools" menu entry that expands an anchored
    // popover (RemoteAccessPanel) — not openclaw-gated.
    await openTopicsMenuItem(this.page, "Remote Access");
    await this.page
      .locator("text=/No active tunnel|Disable Tunnel|Enable Tailscale/")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  async openSystemStatusPanel() {
    // System Status is the sidebar status-bar gateway button (bottom-left),
    // whose title starts with "Performance". Clicking it opens SystemStatusPanel.
    await this.page.locator('button[title^="Performance"]').first().click();
    await this.page
      .locator("text=Gateway")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  /**
   * The Webhooks panel was removed from the client (no component, no menu
   * entry). The "Webhooks Panel" describe in infra-panels.spec.ts is
   * `test.describe.skip`-ped; this stub only exists so those skipped bodies
   * still typecheck. If you un-skip them, restore the UI first.
   */
  async openWebhooksPanel(): Promise<never> {
    throw new Error("WebhooksPanel was removed from the client (no UI to open).");
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

  async mockWebhooks(webhooks = MOCK_WEBHOOKS) {
    let currentWebhooks = [...webhooks];

    await this.page.route("**/api/webhooks", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ webhooks: currentWebhooks }),
        });
      } else if (method === "POST") {
        const body = route.request().postDataJSON();
        const newWebhook = {
          id: "wh-new-" + Date.now(),
          name: body.name,
          url: body.url,
          secret: "whsec_new",
          events: body.events || [],
          active: body.active ?? true,
          retryCount: 3,
          timeoutMs: 5000,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        currentWebhooks = [newWebhook, ...currentWebhooks];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(newWebhook),
        });
      } else {
        await route.fallback();
      }
    });

    await this.page.route("**/api/webhooks/*/test", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "success" }),
        });
      } else {
        await route.fallback();
      }
    });

    await this.page.route("**/api/webhooks/*", async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      // Skip /test endpoint
      if (url.includes("/test")) {
        await route.fallback();
        return;
      }

      if (method === "PATCH") {
        const body = route.request().postDataJSON();
        const id = url.split("/").pop();
        const updated = currentWebhooks.find((w) => w.id === id);
        if (updated) {
          Object.assign(updated, body);
        }
        currentWebhooks = currentWebhooks.map((w) =>
          w.id === id ? { ...w, ...body } : w
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(updated || body),
        });
      } else if (method === "DELETE") {
        const id = url.split("/").pop();
        currentWebhooks = currentWebhooks.filter((w) => w.id !== id);
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

  async mockRemoteStatus(status = MOCK_TUNNEL_INACTIVE) {
    let currentStatus = { ...status };

    await this.page.route("**/api/remote/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(currentStatus),
      });
    });

    await this.page.route("**/api/remote/tunnel", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        if (body.action === "start") {
          currentStatus = { ...MOCK_TUNNEL_ACTIVE };
        } else {
          currentStatus = { ...MOCK_TUNNEL_INACTIVE };
        }
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
