import { test } from "./fixtures/infra.fixture";
import { expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

// The Cron panel is gone (HUBBR-14): the OpenClaw jobs and their three commands
// live in Automazioni, and tests/e2e/automations.spec.ts covers CRON-01,
// CRONUI-01 and CRONUI-01b there.

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
  test("STATUS-04: PTY bridge failure is visible and recovers", async ({ page, infraPage, request }) => {
    test.info().annotations.push({ type: "spec", description: "SYSTEM-03" });
    const setBridge = async (enabled: boolean | null) => {
      const socketPath = enabled === false ? "/tmp/topics-e2e-missing-pty-bridge.sock" : null;
      const response = await request.post("/api/test/system/pty-bridge", { data: { socketPath } });
      expect(response.ok()).toBeTruthy();
    };

    await setBridge(false);
    try {
      await page.goto("/");
      await infraPage.openSystemStatusPanel();
      const row = page.getByTestId("system-health-pty-bridge");
      await expect(row).toHaveAttribute("data-state", "error");
      // The catalogue's words for `socket-missing` (it-IT, the e2e locale): the reason and the remedy.
      await expect(row.getByText("Socket del bridge assente.")).toBeVisible();
      await expect(row.getByText("Riavvia il bridge.")).toBeVisible();

      await setBridge(true);
      await page.getByTestId("system-status-refresh").click();
      await expect(row).toHaveAttribute("data-state", "ok", { timeout: 10_000 });
      await expect(row.getByText("Il socket accetta connessioni.")).toBeVisible();
    } finally {
      await setBridge(null);
    }
  });

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

    // No Gateway, no server uptime, no Cron Jobs, even with OpenClaw on: the
    // gateway and the server are services of the machine's Processes view, the
    // jobs live in Automations. This panel keeps the facts of this window.
    await expect(statusPanel.getByText(/Gateway|uptime|Cron Jobs/)).toHaveCount(0);

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

  test("STATUS-03: Nothing restarts from the panel, even with OpenClaw on", async ({
    page,
    infraPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "SYSTEM-01" });
    await infraPage.mockSystemStatus();
    await page.goto("/");
    await infraPage.openSystemStatusPanel();

    const statusPanel = page.getByTestId("system-status-panel");
    await expect(statusPanel.getByText("Archiviati")).toBeVisible();
    await expect(statusPanel.getByRole("button", { name: /Riavvia/ })).toHaveCount(0);
  });
});
