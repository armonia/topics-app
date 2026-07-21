import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";

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
  test("a second viewer of the same context receives the navigation state broadcast", async ({ page, baseURL }) => {
    await goToApp(page);

    const ctx = `e2e-shared-${Date.now()}`;
    // A server-local URL: the test server serves its own root, so the headless
    // page's `load` fires (→ nav broadcast) with zero external network.
    const navUrl = `${baseURL ?? "http://localhost:13334"}/`;

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

        // Poll up to ~12s for B to receive a nav broadcast carrying the new url.
        const deadline = Date.now() + 12000;
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
        };
        try { A.ws.close(); B.ws.close(); } catch { /* ignore */ }
        return out;
      },
      { ctx, navUrl },
    );

    // The core guarantee: viewer B (the "other device") saw the navigation state
    // even though viewer A drove it — the pane state is genuinely shared.
    expect(result.bReceivedState).toBe(true);
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
    const base = baseURL ?? "http://localhost:13334";
    const viewersUrl = `${base}/api/browsers/${encodeURIComponent(ctx)}/viewers`;

    const readCount = async (): Promise<number> => {
      const res = await request.get(viewersUrl);
      if (!res.ok()) return -1;
      const data = await res.json();
      return typeof data?.count === "number" ? data.count : -1;
    };

    // No viewers yet.
    expect(await readCount()).toBe(0);

    // Open two live viewers. Each sends set_stream:false immediately so the server
    // skips launching a headless Chromium (within its 250ms grace) — the count is
    // membership-based, so it still reflects both connections.
    await page.evaluate(async ({ ctx }) => {
      const wsBase = location.origin.replace(/^http/, "ws");
      const open = () => new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws/browser/${encodeURIComponent(ctx)}`);
        ws.addEventListener("open", () => { ws.send(JSON.stringify({ type: "set_stream", active: false })); resolve(ws); });
        ws.addEventListener("error", () => reject(new Error("ws error")));
      });
      // Stash on window so a later evaluate can close one.
      (window as unknown as { __viewers: WebSocket[] }).__viewers = await Promise.all([open(), open()]);
    }, { ctx });

    // Poll until the server sees both.
    let count = -1;
    for (let i = 0; i < 40 && count !== 2; i++) { count = await readCount(); if (count !== 2) await page.waitForTimeout(150); }
    expect(count).toBe(2);

    // Close one viewer → the count drops to 1.
    await page.evaluate(() => {
      const arr = (window as unknown as { __viewers: WebSocket[] }).__viewers;
      arr[0].close();
    });
    let after = -1;
    for (let i = 0; i < 40 && after !== 1; i++) { after = await readCount(); if (after !== 1) await page.waitForTimeout(150); }
    expect(after).toBe(1);

    // Clean up the remaining viewer.
    await page.evaluate(() => {
      const arr = (window as unknown as { __viewers: WebSocket[] }).__viewers;
      arr[1].close();
    });
  });
});
