import type { Page } from "@playwright/test";

/**
 * Shared helpers for the OpenClaw-gated utility surfaces (Activity, Agents,
 * Cron Jobs, …). These panes used to hang off standalone header buttons; they
 * now live inside the "Settings & Tools" (Topics ▾) dropdown and only render
 * when `openclawAvailable` is true. The isolated test server reports openclaw
 * as unconfigured, so tests must stub availability AND open the menu.
 */

const READY_OPENCLAW = {
  name: "openclaw",
  label: "OpenClaw",
  status: "ready",
  isDefault: true,
  models: [] as unknown[],
  requirements: [] as unknown[],
  fetchedAt: "2026-01-01T00:00:00Z",
};

/**
 * Make `openclawAvailable` resolve to true. The providers snapshot reaches the
 * client over TWO channels — an HTTP GET (`/api/providers/snapshot`) and a
 * `providers:snapshot` WS frame pushed on connect — and providersSnapshotStore
 * is last-write-wins, so a real "unavailable" WS frame landing after the HTTP
 * mock would flip availability back to false (a timing race). Stub both: fulfil
 * the GET with openclaw "ready" and proxy the WS, rewriting any
 * `providers:snapshot` frame so openclaw is always "ready". All other frames
 * pass through untouched. Register BEFORE page.goto().
 */
export async function mockOpenClawAvailable(page: Page) {
  await page.route("**/api/providers/snapshot", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: [READY_OPENCLAW],
        defaultProvider: "openclaw",
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });
  });

  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((msg) => {
      const text = typeof msg === "string" ? msg : "";
      if (text.includes('"providers:snapshot"')) {
        try {
          const frame = JSON.parse(text);
          const provs = frame?.snapshot?.providers;
          if (frame?.type === "providers:snapshot" && Array.isArray(provs)) {
            const oc = provs.find((p: { name?: string }) => p.name === "openclaw");
            if (oc) oc.status = "ready";
            else provs.push({ ...READY_OPENCLAW });
            ws.send(JSON.stringify(frame));
            return;
          }
        } catch {
          // Malformed frame — fall through to verbatim passthrough.
        }
      }
      ws.send(msg);
    });
    ws.onMessage((msg) => server.send(msg));
  });
}

/**
 * Open a utility pane from the "Settings & Tools" (Topics ▾) dropdown by its
 * menu-row accessible name (e.g. "Activity", "Agents", "Statistics",
 * "Cron Jobs", "Remote Access"). The click is scoped to the menu portal — the
 * div whose DIRECT child is the "Reimposta pannelli" button — so it never
 * collides with the pane's own header button (same name) once the pane is open
 * and persisted across the serial suite.
 */
export async function openTopicsMenuItem(page: Page, name: string | RegExp) {
  await page.locator('button[title="Settings & Tools"]').click();
  const topicsMenu = page.locator(
    'div:has(> button:has-text("Reimposta pannelli"))',
  );
  await topicsMenu.getByRole("button", { name }).click();
}
