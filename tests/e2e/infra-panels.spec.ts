import { test } from "./fixtures/infra.fixture";
import { expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

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

    await page.goto("/");
    await infraPage.openCronPanel();

    // Verify job exists
    await expect(page.getByText("Daily backup")).toBeVisible();

    // Hover the job text to reveal actions
    await page.getByText("Daily backup").hover();

    // Click Delete (revealed by hover)
    await page.locator('button[title="Delete"]').first().click();

    // La conferma è il ConfirmDialog React di `useConfirm`, non `window.confirm`
    // (un modale nativo congela la WKWebView intera): niente evento `dialog` da
    // accettare, c'è un `role="dialog"` da confermare. Il click va SCOPATO al
    // dialog — anche la riga della lista ha un bottone che si chiama "Delete".
    const confirmDialog = page.getByRole("dialog", { name: "Delete this job?" });
    await expect(confirmDialog).toBeVisible({ timeout: 3_000 });
    await confirmDialog.getByRole("button", { name: "Delete" }).click();

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

// Il pannello «Accesso remoto» NON esiste più, e non è una svista.
// Il prodotto è stato cancellato in `005c93e5` (RemoteAccessPanel.tsx,
// server/routes/remote.ts, lib/tailscale-bin.ts, la voce nel menu Topics ▾) e il
// requisito è stato RITIRATO formalmente in `ce456581`:
// `openspec/changes/device-auth/specs/remote-access/spec-removal.md` elenca
// REMOTE-01 e LAN-OPEN-03 sotto «## REMOVED Requirements». Motivo registrato lì:
// il tunnel terminava sulla macchina e inoltrava a loopback, quindi ogni
// richiesta si presentava al server come LOCALE — la classe più fidata, quella
// che apre gli endpoint del daemon. Rovesciava il confine di fiducia invece di
// estenderlo, dietro un click in un menu.
// I tre test REMOTE-01/02/03 che stavano qui coprivano quel pannello e sono stati
// tolti con esso. Quello che li sostituisce è AUTH-01..04: si raggiunge il server
// sulla rete locale e si autorizza il dispositivo una volta.

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
    const statusPanel = page.getByTestId("system-status-panel");

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

    // The panel opens INSIDE the «Topics» menu now, so it has its own testid:
    // the menu is a ".glass-surface" with «Gateway» in it too.
    const statusPanel = page.getByTestId("system-status-panel");

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
