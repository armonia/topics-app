/**
 * @covers SNAPSYNC-01
 */
import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Slice 4 verification — the killer test.
 *
 * Two browser pages open the same app. Each does ONE initial HTTP fetch of
 * `/api/providers/snapshot` on first paint. From there, both pages stay in
 * lockstep via the WebSocket `providers:snapshot` broadcast. Triggering a
 * refresh from Settings in page A pushes a new snapshot to BOTH pages without
 * either re-fetching over HTTP.
 */
test.describe.serial("Providers snapshot sync (cross-window)", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Snapshot Sync " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // I test cross-window di questo file leggono il picker (uno per pane chat):
  // con le pane dei file precedenti ancora aperte — il pane-store è unico per
  // tutta la suite seriale — il locator risolve a più elementi.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("snapshot REST returns valid shape", async ({ request }) => {
    const resp = await request.get("/api/providers/snapshot");
    expect(resp.ok()).toBeTruthy();
    const data = await resp.json();
    expect(Array.isArray(data.providers)).toBe(true);
    expect(typeof data.generatedAt).toBe("string");
    expect(data.defaultProvider === null || typeof data.defaultProvider === "string").toBe(true);
    for (const p of data.providers) {
      expect(p).toHaveProperty("name");
      expect(p).toHaveProperty("status");
      expect(["ready", "loading", "error", "unavailable"]).toContain(p.status);
      expect(Array.isArray(p.models)).toBe(true);
      expect(Array.isArray(p.requirements)).toBe(true);
      expect(typeof p.fetchedAt).toBe("string");
    }
  });

  test("snapshot/refresh accepts empty body and {provider}", async ({ request }) => {
    const a = await request.post("/api/providers/snapshot/refresh", { data: {} });
    expect(a.ok()).toBeTruthy();
    const b = await request.post("/api/providers/snapshot/refresh", { data: { provider: "claude-code" } });
    expect(b.ok()).toBeTruthy();
  });

  test("two pages receive the same snapshot via WS without polling", async ({ browser }) => {
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // Per-page counters: how many times each one fetched /providers/snapshot
    // (first-paint REST) and how many WS frames of type providers:snapshot
    // it has observed.
    const httpHits = { A: 0, B: 0 } as Record<"A" | "B", number>;
    const wsFrames = { A: 0, B: 0 } as Record<"A" | "B", number>;

    pageA.on("request", (req) => {
      if (req.url().includes("/api/providers/snapshot") && req.method() === "GET") httpHits.A++;
    });
    pageB.on("request", (req) => {
      if (req.url().includes("/api/providers/snapshot") && req.method() === "GET") httpHits.B++;
    });

    // Hook the WS frame stream by injecting a tap into wsFrameBus before app code runs.
    // We expose a counter on `window.__wsSnapshotCount` that the test polls.
    await pageA.addInitScript(() => {
      (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount = 0;
      const origWS = window.WebSocket;
      class WrappedWS extends origWS {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (ev: MessageEvent) => {
            try {
              const m = JSON.parse(String(ev.data));
              if (m && m.type === "providers:snapshot") {
                (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount++;
              }
            } catch { /* not JSON */ }
          });
        }
      }
      (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = WrappedWS as unknown as typeof WebSocket;
    });
    await pageB.addInitScript(() => {
      (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount = 0;
      const origWS = window.WebSocket;
      class WrappedWS extends origWS {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (ev: MessageEvent) => {
            try {
              const m = JSON.parse(String(ev.data));
              if (m && m.type === "providers:snapshot") {
                (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount++;
              }
            } catch { /* not JSON */ }
          });
        }
      }
      (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = WrappedWS as unknown as typeof WebSocket;
    });

    // Open the same topic in both pages so the picker is rendered on each.
    await goToApp(pageA);
    await pageA.keyboard.press("Escape");
    await openTopic(pageA, new RegExp(topicName));
    await goToApp(pageB);
    await pageB.keyboard.press("Escape");
    await openTopic(pageB, new RegExp(topicName));

    // Wait for both pages to have received at least one WS snapshot (the
    // initial broadcast on connect).
    await expect.poll(
      () => pageA.evaluate(() => (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount),
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(1);
    await expect.poll(
      () => pageB.evaluate(() => (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount),
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(1);

    // Snapshot both counters so we can assert HTTP stays flat across the
    // refresh round-trip (the actual contract: refresh-driven updates ride the
    // WS, not new GET /snapshot polls).
    const beforeA = await pageA.evaluate(() => (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount);
    const beforeB = await pageB.evaluate(() => (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount);
    const httpBeforeA = httpHits.A;
    const httpBeforeB = httpHits.B;

    // Trigger a server-side refresh (simulates clicking the refresh button in
    // page A's picker — the picker also POSTs to /snapshot/refresh).
    const r = await pageA.request.post("/api/providers/snapshot/refresh", { data: {} });
    expect(r.ok()).toBeTruthy();

    // Both pages should observe at least ONE additional snapshot frame within
    // a couple of seconds (the server debounces broadcasts at 100ms).
    await expect.poll(
      () => pageA.evaluate(() => (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount),
      { timeout: 5_000 },
    ).toBeGreaterThan(beforeA);
    await expect.poll(
      () => pageB.evaluate(() => (window as unknown as { __wsSnapshotCount: number }).__wsSnapshotCount),
      { timeout: 5_000 },
    ).toBeGreaterThan(beforeB);

    // Crucially: refresh did NOT cause additional HTTP /snapshot fetches.
    // Whatever first-paint hits occurred (could be 1, could be 2 if HMR/reconnect
    // briefly bounced the WS), they must stay flat — the WS broadcast IS the
    // resync channel.
    expect(httpHits.A).toBe(httpBeforeA);
    expect(httpHits.B).toBe(httpBeforeB);

    await ctxA.close();
    await ctxB.close();
  });
});
