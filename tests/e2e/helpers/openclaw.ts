import type { Page } from "@playwright/test";

/**
 * Shared helpers for the utility panes (Dashboard, Cron, Board), plus the
 * OpenClaw availability stub they sometimes need.
 *
 * Le pane utility hanno cambiato porta due volte: prima bottoni nella testata
 * standalone, poi il dropdown «Settings & Tools» (Topics ▾), oggi il menu «New»
 * (⌘N) come ogni altra pane. Cron è l'unica ancora GATED su OpenClaw
 * (`PaneConfig.requires`), e il server di test lo riporta non configurato:
 * quel test deve quindi stubbare la disponibilità PRIMA di aprire il menu, o
 * la riga non esiste proprio.
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
 * Apre una pane UTILITY (Dashboard, Cron, Board) dal menu «New» della sidebar —
 * il «+» ⌘N, che è l'unico posto da cui si apre una pane.
 *
 * Stavano nel dropdown «Settings & Tools» (Topics ▾) con nomi loro
 * («Statistics», «Cron Jobs»); erano il menu «+» con altre etichette, e il
 * dropdown è tornato a essere solo vista + azioni di layout + Settings.
 *
 * Il locator è il `data-testid` della riga e non il nome accessibile: le righe
 * di `PaneAddMenu` sono `role="menuitem"` dentro un `role="menu"` (da baff80a5),
 * quindi `getByRole("button", …)` non le trova — stessa scelta di
 * `helpers/terminal-workspace.ts`. In più il testid non collide col bottone
 * omonimo nell'intestazione della pane, una volta che la pane è aperta e
 * sopravvive alla suite seriale.
 */
export async function openAddMenuPane(
  page: Page,
  type: "dashboard" | "cron" | "board",
) {
  // By TESTID: the title contains the shortcut, which changes with the platform
  // (⌘N on a Mac, Ctrl+N elsewhere). See the note in dashboard.spec.ts.
  //
  // `.first()` IS THE SIDEBAR'S TRIGGER, and it is not a tolerance for a stray
  // duplicate. Once ANY pane is open the tab bar grows a second «+» carrying
  // the same testid, so from the second test of a file onwards - the pane store
  // survives between tests in the same worker - strict mode found two and threw
  // before the menu ever opened. The one that always exists, open panes or not,
  // is the one in the column.
  await page.getByTestId("pane-add-menu-trigger").first().click();
  const row = page.getByTestId(`pane-add-menu-${type}`);
  await row.waitFor({ state: "visible", timeout: 5000 });
  await row.click();
}
