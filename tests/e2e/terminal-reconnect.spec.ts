import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  gotoTerminalProject,
  openShellViaSidebar,
} from "./helpers/terminal-workspace";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * TERM-03: la riconnessione automatica dopo un WebSocket caduto.
 *
 *
 * Sta in un file suo perche' l'intercettazione WS va installata PRIMA della
 * navigazione, quindi non puo' usare la scorciatoia `navigateAndOpenTerminal`
 * degli altri: apre il progetto e la shell in due passi separati.
 *
 * La famiglia terminale sta in tre file — `terminal`, `terminal-reconnect`,
 * `terminal-multi` — che prima erano tre `describe` dentro un unico file da 76
 * secondi. Poiche' Playwright distribuisce gli shard PER FILE, quei 76 secondi
 * erano un pavimento sotto cui il wall-clock non poteva scendere con nessun
 * numero di shard. La procedura condivisa (apri il progetto, "+" -> Shell,
 * aspetta il prompt) vive in `helpers/terminal-workspace.ts`: era ricopiata
 * tre volte, gia' divergente fra le copie.
 */
test.describe("Terminal Reconnect", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "reconnect"));
  });

  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("TERM-03: terminal auto-reconnects after WebSocket disconnect", async ({
    page,
    terminalPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    // Set up WS interception BEFORE navigation to capture terminal WS connections
    type WsRoute = {
      close: (options?: { code?: number; reason?: string }) => void | Promise<void>;
    };
    const serverConnections: WsRoute[] = [];
    // We drive the disconnect from the CLIENT side (below), so keep the page-
    // side routes too. Closing the SERVER route does not reliably surface a
    // close event to the browser's WebSocket under Playwright's proxy (the
    // custom close code isn't propagated), so the client never sees the drop
    // and never reconnects. Closing the CLIENT route makes the page's socket
    // fire `onclose` with our non-1000 code — exactly a real network drop —
    // which is what SingleTerminalPane's auto-reconnect keys off.
    const clientConnections: WsRoute[] = [];
    await page.routeWebSocket(/\/ws\/terminal\//, (ws) => {
      const server = ws.connectToServer();
      serverConnections.push(server);
      clientConnections.push(ws);
      // Transparent proxy — pass through all messages
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    // Navigazione e apertura in DUE passi: l'intercettazione qui sopra doveva
    // essere installata prima di `goto`, quindi questo test non puo' usare
    // `navigateAndOpenTerminal` (che fa entrambe le cose in una volta).
    await gotoTerminalProject(page, topicName);
    await openShellViaSidebar(page, terminalPage);

    // Verify terminal works before disconnect
    const marker1 = `pre-disconnect-${Date.now()}`;
    await terminalPage.focus();
    await terminalPage.typeCommand(`echo ${marker1}`);
    await terminalPage.waitForOutput(marker1);

    // Capture current server connection count
    const connectionsBefore = serverConnections.length;
    expect(connectionsBefore).toBeGreaterThanOrEqual(1);

    // Trigger disconnect by closing the CLIENT-side connection with a non-1000
    // code. Code 1000 is treated as a clean PTY-exit and the client will NOT
    // reconnect (SingleTerminalPane.tsx:376-382); 1001 forces auto-reconnect.
    const lastClient = clientConnections[clientConnections.length - 1];
    await lastClient.close({ code: 1001, reason: "e2e-disconnect" });

    // Wait for client to auto-reconnect — a new server connection should appear
    await expect(async () => {
      expect(serverConnections.length).toBeGreaterThan(connectionsBefore);
    }).toPass({ timeout: 15_000 });

    // Wait for terminal to stabilize after reconnect
    // The PTY process survives the WS disconnect; only the WS link broke
    // After reconnect, the shell is still alive and accepts commands
    await terminalPage.focus();
    const marker2 = `post-reconnect-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker2}`);
    await terminalPage.waitForOutput(marker2, 15_000);
  });
});
