import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { closeAllBrowserContexts } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

// Chi sporca pulisce: vedi la docstring di `closeAllBrowserContexts`.
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

/**
 * Shared browser session — "condivisi nello stato tra Mac app e PWA".
 *
 * The Mac app pane (with "Condividi sessione" ON) and a PWA/web pane viewing the
 * same topic are, at the protocol level, TWO identical streaming viewers of ONE
 * server-side context on /ws/browser/<ctx>. The server fans the single headless
 * page out to every viewer (browserWsClients set) AND — the state half — rebroadcasts
 * navigation to ALL of them: browser-service's page.on('load') → broadcastToBrowserWs
 * a `nav`/url message, so every viewer's URL bar tracks the shared page.
 *
 * This drives the REAL test server (no WS mock, no internal stubbing — CLAUDE.md
 * "no mocking internals"): two live WebSocket viewers of the same context, one
 * navigates, the other must receive the nav broadcast. Deterministic — it rides
 * the WS control channel (the state fan-out), not the WebRTC video transport, so
 * it needs no sidecar/ICE. Navigates to a SERVER-LOCAL url so it never depends on
 * outbound internet in CI.
 */
test.describe("Shared browser session — state fan-out (Mac ↔ PWA)", () => {
  /**
   * QUESTO FILE NON GIRA NEL GATE DELLE PR, ed è una scoperta, non una resa.
   *
   * Per settimane è stato «l'ultimo rosso, flaky solo sotto sharding, verde in
   * isolamento» — una frase vera che ha impedito a chiunque di guardare. Con un
   * messaggio d'errore che dice cosa è ARRIVATO invece di un solo «false», il
   * conto è saltato fuori in un giro: `ricevuti []`, cioè ZERO frame. Non un
   * ritardo — il broadcast non partiva affatto. E nel log del server c'era il
   * perché: `launch: Timeout 180000ms exceeded`. Il Chromium headless che il
   * test fa aprire NON PARTE quando quattro shard più i browser di Playwright
   * si contendono la macchina; tre minuti, e rinuncia.
   *
   * Cioè: un limite di capacità della macchina, che il test non può distinguere
   * da un difetto del prodotto. La famiglia che apre browser veri sta già in
   * `NIGHTLY_ONLY_SPECS` per la stessa ragione (`browser-ws-streaming`,
   * `browser-persistence`, `browser-agent-control`, `browser-login-state`):
   * questo file ne fa parte e ne era rimasto fuori. Nel notturno gira senza
   * sharding, quindi la copertura non si perde — si sposta dove è affidabile.
   */
  test("a second viewer of the same context receives the navigation state broadcast", async ({ page, baseURL }) => {
    // IL TETTO DEL FILE È 30s, E QUI NON BASTA: questo test aspetta che il
    // server lanci un Chromium headless, ci apra una pagina e la navighi.
    test.setTimeout(60_000);
    await goToApp(page);

    const ctx = `e2e-shared-${Date.now()}`;
    // A server-local URL: the test server serves its own root, so the headless
    // page's `load` fires (→ nav broadcast) with zero external network.
    const navUrl = `${baseURL ?? E2E_BASE}/`;

    const result = await page.evaluate(
      async ({ ctx, navUrl }) => {
        const wsBase = location.origin.replace(/^http/, "ws");
        const open = (): { ws: WebSocket; navs: { phase?: string; url?: string }[]; opened: Promise<void> } => {
          const ws = new WebSocket(`${wsBase}/ws/browser/${encodeURIComponent(ctx)}`);
          const navs: { phase?: string; url?: string }[] = [];
          ws.addEventListener("message", (ev) => {
            let m: { type?: string; phase?: string; url?: string };
            try { m = JSON.parse((ev as MessageEvent).data); } catch { return; }
            if (m.type === "nav") navs.push({ phase: m.phase, url: m.url });
          });
          const opened = new Promise<void>((res, rej) => {
            ws.addEventListener("open", () => res());
            ws.addEventListener("error", () => rej(new Error("ws error")));
          });
          return { ws, navs, opened };
        };

        // Viewer A (Mac-sim) and Viewer B (PWA-sim) — same context, both live
        // BEFORE the navigation so B is subscribed when the broadcast fires.
        const A = open();
        const B = open();
        await Promise.all([A.opened, B.opened]);

        // A navigates the shared page. The server navigates the ONE headless page
        // and, on its `load`, rebroadcasts the nav/url to every viewer (A and B).
        A.ws.send(JSON.stringify({ type: "nav", url: navUrl, phase: "request" }));

        // Quanto si aspetta il broadcast: 12s da soli bastano, ma con margine
        // costano poco e tolgono di mezzo la variabile del tempo — che qui era
        // la spiegazione comoda e sbagliata (vedi il commento del file).
        const deadline = Date.now() + 25000;
        const target = new URL(navUrl).href;
        const sawOn = (navs: { phase?: string; url?: string }[]) =>
          navs.some((n) => n.phase === "response" && !!n.url && new URL(n.url).href === target);
        while (Date.now() < deadline) {
          if (sawOn(B.navs)) break;
          await new Promise((r) => setTimeout(r, 200));
        }

        const out = {
          bReceivedState: sawOn(B.navs),
          aReceivedState: sawOn(A.navs),
          bNavCount: B.navs.length,
          // Cosa è arrivato davvero: senza, un rosso dice solo «false» e
          // costringe a rifare il giro per sapere se il broadcast è mancato del
          // tutto o è arrivato con un'altra url.
          visti: B.navs.slice(0, 6),
          atteso: target,
        };
        try { A.ws.close(); B.ws.close(); } catch { /* ignore */ }
        return out;
      },
      { ctx, navUrl },
    );

    // The core guarantee: viewer B (the "other device") saw the navigation state
    // even though viewer A drove it — the pane state is genuinely shared.
    expect(
      result.bReceivedState,
      `il secondo spettatore non ha visto la navigazione. Atteso ${result.atteso}, ricevuti ${JSON.stringify(result.visti)}`,
    ).toBe(true);
    // And the driving viewer sees it too (its own nav response + the broadcast).
    expect(result.aReceivedState).toBe(true);
  });

  // Cross-device auto-share signal: GET /api/browsers/:id/viewers reports how many
  // devices are streaming a context. A desktop pane rendering natively holds NO
  // streaming WS, so this count IS the number of OTHER devices watching the shared
  // session — the trigger that flips an 'auto' pane to shared and back. Drives
  // computeAutoShared (unit-tested); here we prove the server signal it consumes.
  test("the viewer-count endpoint tracks streaming viewers of a context", async ({ page, request, baseURL }) => {
    await goToApp(page);
    const ctx = `e2e-viewers-${Date.now()}`;
    const base = baseURL ?? E2E_BASE;
    const viewersUrl = `${base}/api/browsers/${encodeURIComponent(ctx)}/viewers`;

    const readCount = async (): Promise<number> => {
      const res = await request.get(viewersUrl);
      if (!res.ok()) return -1;
      const data = await res.json();
      return typeof data?.count === "number" ? data.count : -1;
    };

    // No viewers yet.
    expect(await readCount()).toBe(0);

    // Open two live viewers + one NATIVE-DELEGATE connection (a Tauri native pane
    // registers register_native_executor over its own /ws/browser socket). Each
    // viewer sends set_stream:false immediately so the server skips launching a
    // headless Chromium (within its 250ms grace). The delegate must NOT be counted
    // — that was the "browser resets every 2s" oscillation bug.
    await page.evaluate(async ({ ctx }) => {
      const wsBase = location.origin.replace(/^http/, "ws");
      const open = (kind: "viewer" | "delegate") => new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws/browser/${encodeURIComponent(ctx)}`);
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify(kind === "delegate" ? { type: "register_native_executor" } : { type: "set_stream", active: false }));
          resolve(ws);
        });
        ws.addEventListener("error", () => reject(new Error("ws error")));
      });
      const viewers = await Promise.all([open("viewer"), open("viewer")]);
      const delegate = await open("delegate");
      (window as unknown as { __viewers: WebSocket[]; __delegate: WebSocket }).__viewers = viewers;
      (window as unknown as { __viewers: WebSocket[]; __delegate: WebSocket }).__delegate = delegate;
    }, { ctx });

    // Poll until the server sees exactly the two viewers (delegate excluded).
    // `expect.poll` instead of a hand-rolled loop with a sleep in it: same
    // condition, but the failure message carries the last value seen instead of
    // a bare `-1 !== 2`, and the wait ends on the value rather than on a tick.
    await expect.poll(readCount, { timeout: 6_000, message: "il server deve contare i due viewer" }).toBe(2);

    // Close one viewer → the count drops to 1 (delegate still excluded).
    await page.evaluate(() => {
      (window as unknown as { __viewers: WebSocket[] }).__viewers[0].close();
    });
    await expect.poll(readCount, { timeout: 6_000, message: "chiuso un viewer, il conto deve scendere a 1" }).toBe(1);

    // The surviving viewer says its pane left the screen (set_watching:false) —
    // WITHOUT closing the socket. It must drop out of the count: a phone with
    // the tab in the background is not a reason to hold this desktop's 'auto'
    // pane in the shared session. Note it already sent set_stream:false above
    // and was still counted: the transport pause is NOT this signal (the
    // default transport, WebRTC, pauses the screencast while watching).
    await page.evaluate(() => {
      (window as unknown as { __viewers: WebSocket[] }).__viewers[1]
        .send(JSON.stringify({ type: "set_watching", active: false }));
    });
    await expect.poll(readCount, { timeout: 6_000, message: "una pane fuori schermo non è un viewer" }).toBe(0);

    // Back on screen → counted again (the same socket, no reconnect).
    await page.evaluate(() => {
      (window as unknown as { __viewers: WebSocket[] }).__viewers[1]
        .send(JSON.stringify({ type: "set_watching", active: true }));
    });
    await expect.poll(readCount, { timeout: 6_000, message: "tornata a schermo, la stessa socket torna contata" }).toBe(1);

    // Clean up.
    await page.evaluate(() => {
      const w = window as unknown as { __viewers: WebSocket[]; __delegate: WebSocket };
      w.__viewers[1].close();
      w.__delegate.close();
    });
  });
});
