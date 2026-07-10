import { test } from "./fixtures/infra.fixture";
import { expect } from "@playwright/test";
import { MOCK_TUNNEL_ACTIVE, MOCK_TUNNEL_INACTIVE } from "./fixtures/infra.fixture";

test.describe("Cron Jobs Panel", () => {
  test("CRON-01: Panel renders job list with enabled/disabled sections", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CRON-01" });
    await infraPage.mockCronJobs();
    await page.goto("/");
    await infraPage.openCronPanel();

    // 2 enabled jobs should be visible
    await expect(page.getByText("Daily backup")).toBeVisible();
    await expect(page.getByText("Nightly sync")).toBeVisible();

    // Disabled section with "1 disabled" summary
    await expect(page.locator("summary").filter({ hasText: "1 disabled" })).toBeVisible();
  });

  test("CRON-02: Toggle button visible for enabled/disabled jobs", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CRON-01" });
    await infraPage.mockCronJobs();
    await page.goto("/");
    await infraPage.openCronPanel();

    // Enabled jobs show "Disable" toggle button (2 enabled jobs)
    await expect(page.locator('button[title="Disable"]')).toHaveCount(2);

    // Expand disabled section — disabled jobs show "Enable" toggle button
    await page.locator("summary").filter({ hasText: "1 disabled" }).click();
    await expect(page.locator('button[title="Enable"]')).toHaveCount(1);
  });

  test("CRON-03: Run job now", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CRON-01" });
    await infraPage.mockCronJobs();

    // Track POST /run request
    let runRequested = false;
    await page.route("**/api/cron/jobs/*/run", async (route) => {
      runRequested = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/");
    await infraPage.openCronPanel();

    // Hover the "Daily backup" row text to reveal actions (Run/Delete are hover-gated)
    await page.getByText("Daily backup").hover();

    // Click "Run now" (revealed by hover)
    await page.locator('button[title="Run now"]').first().click();

    // Verify the request was made
    expect(runRequested).toBe(true);
  });

  test("CRON-04: Delete job with confirm dialog", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CRON-01" });
    await infraPage.mockCronJobs();

    // Accept the confirm dialog
    page.on("dialog", (d) => d.accept());

    await page.goto("/");
    await infraPage.openCronPanel();

    // Verify job exists
    await expect(page.getByText("Daily backup")).toBeVisible();

    // Hover the job text to reveal actions
    await page.getByText("Daily backup").hover();

    // Click Delete (revealed by hover)
    await page.locator('button[title="Delete"]').first().click();

    // Job should be removed from list
    await expect(page.getByText("Daily backup")).not.toBeVisible();
  });

  test("CRON-05: Empty state shows no cron jobs message", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CRON-01" });
    await infraPage.mockCronJobs([]);
    await page.goto("/");
    await infraPage.openCronPanel();

    await expect(page.getByText("No cron jobs")).toBeVisible();
  });
});

// Skip motivato: la WebhooksPanel è stata rimossa dal client (nessun componente
// né voce di menu). Gli endpoint /api/webhooks e i relativi mock restano per un
// eventuale ripristino, ma non esiste più una UI da pilotare.
test.describe.skip("Webhooks Panel", () => {
  test("WEBHOOK-01: Panel renders webhook list", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "WEBHOOK-01" });
    await infraPage.mockWebhooks();
    await page.goto("/");
    await infraPage.openWebhooksPanel();

    // 2 webhook rows
    await expect(page.locator('[data-testid="webhook-row"]')).toHaveCount(2);

    // Names visible
    await expect(page.getByText("Deploy Hook")).toBeVisible();
    await expect(page.getByText("Audit Logger")).toBeVisible();
  });

  test("WEBHOOK-02: Create new webhook", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "WEBHOOK-01" });
    await infraPage.mockWebhooks();
    await page.goto("/");
    await infraPage.openWebhooksPanel();

    // Click "Add webhook"
    await page.locator('[data-testid="webhook-create-btn"]').click();

    // Form should appear
    const form = page.locator('[data-testid="webhook-form"]');
    await expect(form).toBeVisible();

    // Fill in the form
    await form.locator('input[placeholder="Name"]').fill("New Hook");
    await form.locator('input[placeholder="https://example.com/webhook"]').fill("https://new.example.com/hook");

    // Select an event checkbox
    await form.locator('label').filter({ hasText: "topic.created" }).click();

    // Click Create
    await form.getByRole("button", { name: "Create" }).click({ force: true });

    // Should return to list with new webhook visible
    await expect(page.locator('[data-testid="webhook-row"]')).toHaveCount(3);
    await expect(page.getByText("New Hook")).toBeVisible();
  });

  test("WEBHOOK-03: Active/inactive webhooks show correct toggle buttons", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "WEBHOOK-01" });
    await infraPage.mockWebhooks();
    await page.goto("/");
    await infraPage.openWebhooksPanel();

    // First webhook (active) has "Disable" button, second (inactive) has "Enable"
    const rows = page.locator('[data-testid="webhook-row"]');
    await expect(rows).toHaveCount(2);

    // Active webhook row shows Disable toggle
    await expect(rows.first().locator('button[title="Disable"]')).toBeVisible();

    // Inactive webhook row shows Enable toggle
    await expect(rows.nth(1).locator('button[title="Enable"]')).toBeVisible();
  });

  test("WEBHOOK-04: Test delivery", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "WEBHOOK-01" });
    await infraPage.mockWebhooks();
    await page.goto("/");
    await infraPage.openWebhooksPanel();

    // Hover first webhook row to reveal actions
    const firstRow = page.locator('[data-testid="webhook-row"]').first();
    await firstRow.hover();

    // Click "Test delivery"
    await firstRow.locator('button[title="Test delivery"]').click();

    // Should show "Test: success" text
    await expect(firstRow.getByText("Test: success")).toBeVisible();
  });

  test("WEBHOOK-05: Delete webhook with confirm", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "WEBHOOK-01" });
    await infraPage.mockWebhooks();

    page.on("dialog", (d) => d.accept());

    await page.goto("/");
    await infraPage.openWebhooksPanel();

    await expect(page.locator('[data-testid="webhook-row"]')).toHaveCount(2);

    // Hover and delete first webhook
    const firstRow = page.locator('[data-testid="webhook-row"]').first();
    await firstRow.hover();
    await firstRow.locator('button[title="Delete"]').click();

    // Should have 1 row remaining
    await expect(page.locator('[data-testid="webhook-row"]')).toHaveCount(1);
    await expect(page.getByText("Deploy Hook")).not.toBeVisible();
  });

  test("WEBHOOK-06: Empty state shows no webhooks", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "WEBHOOK-01" });
    await infraPage.mockWebhooks([]);
    await page.goto("/");
    await infraPage.openWebhooksPanel();

    await expect(page.getByText("No webhooks")).toBeVisible();
  });
});

test.describe("Remote Access Panel", () => {
  test("REMOTE-01: Active tunnel shows URL and controls", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "REMOTE-01" });
    await infraPage.mockRemoteStatus(MOCK_TUNNEL_ACTIVE);
    await page.goto("/");
    await infraPage.openRemoteAccessPanel();

    // Tunnel URL visible in font-mono span
    await expect(page.locator("span.font-mono").filter({ hasText: "https://test.ts.net" })).toBeVisible();

    // "Disable Tunnel" button visible
    await expect(page.getByText("Disable Tunnel")).toBeVisible();

    // Copy URL button
    await expect(page.locator('button[title="Copy URL"]')).toBeVisible();

    // Open in browser link
    await expect(page.locator('a[title="Open in browser"]')).toBeVisible();
  });

  test("REMOTE-02: Inactive tunnel shows enable button", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "REMOTE-01" });
    await infraPage.mockRemoteStatus(MOCK_TUNNEL_INACTIVE);
    await page.goto("/");
    await infraPage.openRemoteAccessPanel();

    // "No active tunnel" text
    await expect(page.getByText("No active tunnel")).toBeVisible();

    // "Enable Tailscale Funnel" button
    await expect(page.getByText("Enable Tailscale Funnel")).toBeVisible();
  });

  test("REMOTE-03: Toggle tunnel from inactive to active", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "REMOTE-01" });
    await infraPage.mockRemoteStatus(MOCK_TUNNEL_INACTIVE);

    // Track the tunnel POST request
    let tunnelAction: string | null = null;
    await page.route("**/api/remote/tunnel", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        tunnelAction = body.action;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });

    await page.goto("/");
    await infraPage.openRemoteAccessPanel();

    // Click "Enable Tailscale Funnel"
    await page.getByText("Enable Tailscale Funnel").click();

    // Verify POST was sent with action:'start'
    expect(tunnelAction).toBe("start");
  });
});

test.describe("System Status Panel", () => {
  test("STATUS-01: Panel renders all status rows", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "SYSTEM-01" });
    await infraPage.mockSystemStatus();
    await page.goto("/");
    await infraPage.openSystemStatusPanel();

    // Scope every assertion to the dropdown: "Server" also labels the PerfSection
    // RSS block in this same portal, "Online"/"2m" also appear in the sidebar
    // status-bar + version block — a bare getByText hits 2 elements (strict-mode).
    const statusPanel = page.locator(".glass-surface").filter({ hasText: "Gateway" });

    // Gateway row (OpenClaw-gated — mockSystemStatus enables it) → Online, 42ms.
    await expect(statusPanel.getByText("Gateway")).toBeVisible();
    await expect(statusPanel.getByText("Online")).toBeVisible();

    // Server uptime row (120000ms = 2m). "Server" is also the PerfSection RSS
    // label in this dropdown, so identify the row by its unique "uptime" detail.
    await expect(statusPanel.getByText("uptime")).toBeVisible();
    await expect(statusPanel.getByText("2m", { exact: true })).toBeVisible();

    // Cron Jobs row (OpenClaw-gated), enabled/total = 2/3
    await expect(statusPanel.getByText("Cron Jobs")).toBeVisible();
    await expect(statusPanel.getByText("2/3")).toBeVisible();

    // Archiviati row: totalCount(12) − activeCount(5) = 7, detail "12 totali".
    // (The old Memory / "256 MB" row was moved into the PerfSection block above
    // this panel — SystemStatusPanel no longer repeats it.)
    await expect(statusPanel.getByText("Archiviati")).toBeVisible();
    await expect(statusPanel.getByText("12 totali")).toBeVisible();
  });

  test("STATUS-02: Panel shows the open-tabs and archive metric rows", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "SYSTEM-01" });
    // The old WS/Streams/Topics "connections" row was removed by the panel
    // redesign — it was server-wide plumbing the user couldn't act on and the
    // two numbers contradicted each other. It was replaced by honest per-window
    // metrics: "Tab aperti" (every open pane kind) and "Archiviati".
    await infraPage.mockSystemStatus();
    await page.goto("/");
    await infraPage.openSystemStatusPanel();

    // The dropdown is a portalled ".glass-surface" container (SidebarStatusBar).
    const statusPanel = page.locator(".glass-surface").filter({ hasText: "Gateway" });

    // Open-tabs row (paneStore-driven count).
    await expect(statusPanel.getByText("Tab aperti")).toBeVisible();

    // Archive row: 12 total − 5 active = 7 archived, detail "12 totali".
    await expect(statusPanel.getByText("Archiviati")).toBeVisible();
    await expect(statusPanel.getByText("12 totali")).toBeVisible();
  });

  test("STATUS-03: Restart button requires double-click confirmation", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "SYSTEM-01" });
    await infraPage.mockSystemStatus();
    await infraPage.mockOpenclawRestart();
    await page.goto("/");
    await infraPage.openSystemStatusPanel();

    // Initial state: "Riavvia" button
    const restartBtn = page.getByText("Riavvia").first();
    await expect(restartBtn).toBeVisible();

    // First click shows confirmation
    await restartBtn.click();
    await expect(page.getByText("Sei sicuro?")).toBeVisible();

    // Second click triggers restart
    await page.getByText("Sei sicuro?").click();

    // Should show "Riavvio..." or return to "Riavvia"
    await expect(
      page.getByText("Riavvio").or(page.getByText("Riavvia"))
    ).toBeVisible();
  });
});
