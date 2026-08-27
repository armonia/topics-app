import { test, expect } from "./fixtures/browser-v2.fixture";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { readFileSync } from "fs";
import { E2E_BASE, E2E_WS_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

test.describe("BROWSER-CHAT-03 Agent control + native browser tools (@plan-30-05)", () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "BROWSER-CHAT-03" });
    testInfo.annotations.push({ type: "plan", description: "@plan-30-05" });
  });

  test("agent invokes browser_open via REST -> navigation reflected within 2s [BROWSER-CHAT-03 / @plan-30-05]", async ({ request }) => {
    const topic = await createTopic(request, `E2E-AgentOpen-${Date.now()}`);
    const ctxId = topic.id;
    try {
      const res = await request.post(`${BASE}/api/browsers/${ctxId}/agent/open`, {
        data: { url: "https://example.com" },
        headers: { "Content-Type": "application/json" },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { url?: string; title?: string; error?: string };
      expect(body.error).toBeUndefined();
      expect(body.url).toMatch(/example\.com/);
      expect(typeof body.title).toBe("string");
    } finally {
      await request.delete(`${BASE}/api/browsers/${ctxId}`).catch(() => {});
      await deleteTopic(request, ctxId).catch(() => {});
    }
  });

  test("browser_observe returns a compact ref snapshot (incremental) + opt-in annotated screenshot [BROWSER-CHAT-03 / @plan-30-05]", async ({ request }) => {
    const topic = await createTopic(request, `E2E-AgentObserve-${Date.now()}`);
    const ctxId = topic.id;
    try {
      const openRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/open`, {
        data: { url: "https://example.com" },
        headers: { "Content-Type": "application/json" },
      });
      expect(openRes.ok()).toBe(true);

      // Default observe: ref-based snapshot text, NO heavy screenshot.
      const obsRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/observe`, {
        data: { full: true },
        headers: { "Content-Type": "application/json" },
      });
      expect(obsRes.ok()).toBe(true);
      const obs = (await obsRes.json()) as {
        snapshot?: string; count?: number; full?: boolean;
        url?: string; title?: string; screenshot_path?: string; error?: string;
      };
      expect(obs.error).toBeUndefined();
      expect(typeof obs.snapshot).toBe("string");
      // Compact ref lines like `[1] link "..."`.
      expect(obs.snapshot!).toMatch(/\[\d+\]\s+\w+/);
      expect(obs.count!).toBeGreaterThanOrEqual(1);
      expect(obs.full).toBe(true);
      expect(typeof obs.url).toBe("string");
      expect(obs.url!.length).toBeGreaterThan(0);
      // Heavy annotated screenshot is OPT-IN — absent by default.
      expect(obs.screenshot_path).toBeUndefined();

      // Second observe (no full): incremental diff — stable structure costs ~0.
      const obs2Res = await request.post(`${BASE}/api/browsers/${ctxId}/agent/observe`, {
        data: {},
        headers: { "Content-Type": "application/json" },
      });
      const obs2 = (await obs2Res.json()) as { snapshot?: string; full?: boolean };
      expect(obs2.full).toBe(false);
      expect(obs2.snapshot).toMatch(/no element changes|same structure|navigated/);

      // Opt-in capture: a FILE on disk and its path, never the pixels inline.
      const shotRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/observe`, {
        data: { screenshot: true },
        headers: { "Content-Type": "application/json" },
      });
      const shot = (await shotRes.json()) as Record<string, unknown>;
      expect(typeof shot.screenshot_path).toBe("string");
      expect(shot.screenshot_annotated).toBeUndefined();
      const buf = readFileSync(shot.screenshot_path as string);
      expect(buf.length).toBeGreaterThan(50);
      expect([0xff, 0x89]).toContain(buf[0]); // JPEG 0xff / PNG 0x89

      // get_text reads page content.
      const txtRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/get-text`, {
        data: {}, headers: { "Content-Type": "application/json" },
      });
      const txt = (await txtRes.json()) as { text?: string };
      expect(typeof txt.text).toBe("string");
      expect(txt.text!.length).toBeGreaterThan(0);

      // extract: deterministic CSS scrape.
      const exRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/extract`, {
        data: { fields: { heading: "h1" } }, headers: { "Content-Type": "application/json" },
      });
      const ex = (await exRes.json()) as { extracted?: { heading?: string }; error?: string };
      expect(ex.error).toBeUndefined();
      expect(typeof ex.extracted!.heading).toBe("string");
    } finally {
      await request.delete(`${BASE}/api/browsers/${ctxId}`).catch(() => {});
      await deleteTopic(request, ctxId).catch(() => {});
    }
  });

  test("agent_active broadcast: WS receives [active:true, active:false] sequence on error [BROWSER-CHAT-03 / @plan-30-05]", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-AgentLock-${Date.now()}`);
    const ctxId = topic.id;
    try {
      // 1. Open the test page (any blank target works — we just need a window for WS).
      await page.goto(BASE);

      // 2. Open WS to /ws/browser/:id and start recording agent_active messages.
      const wsUrl = `${E2E_WS_BASE}/ws/browser/${ctxId}`;
      await page.evaluate((url) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__msgs = [];
        const ws = new WebSocket(url);
        ws.addEventListener("message", (e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.type === "agent_active") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as any).__msgs.push(m);
            }
          } catch { /* ignore */ }
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__ws = ws;
      }, wsUrl);

      await expect
        .poll(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async () => await page.evaluate(() => (window as any).__ws?.readyState),
          { timeout: 5000 },
        )
        .toBe(1);

      // 3. Trigger an INVALID act (forces handler to fail post-lock). Open
      // first so the handler reaches the act path, not "no context" early-exit.
      await request.post(`${BASE}/api/browsers/${ctxId}/agent/open`, {
        data: { url: "https://example.com" },
        headers: { "Content-Type": "application/json" },
      });

      const actRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/act`, {
        data: { element_id: 999999, action: "click" },
        headers: { "Content-Type": "application/json" },
      });
      // Failsoft: handler returns 200 with { error } OR 500 — both acceptable.
      expect([200, 500]).toContain(actRes.status());

      // 4. Capture the agent_active sequence — withLock try/finally guarantees
      // active:false fires even when the body throws.
      await expect
        .poll(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async () => await page.evaluate(() => (window as any).__msgs.length),
          { timeout: 5000 },
        )
        .toBeGreaterThanOrEqual(2);

      const msgs = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (window as any).__msgs as Array<{ type: string; active: boolean }>,
      );
      const activeTrueIdx = msgs.findIndex((m) => m.active === true);
      const activeFalseIdx = msgs.findIndex((m, i) => i > activeTrueIdx && m.active === false);
      expect(activeTrueIdx).toBeGreaterThanOrEqual(0);
      // false MUST come AFTER true (guaranteed by withLock try/finally).
      expect(activeFalseIdx).toBeGreaterThan(activeTrueIdx);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(() => { try { (window as any).__ws?.close(); } catch { /* ignore */ } });
      await request.delete(`${BASE}/api/browsers/${ctxId}`).catch(() => {});
      await deleteTopic(request, ctxId).catch(() => {});
    }
  });

  test("manage any tab: list-tabs discovers another topic's pane + contextId targets it cross-session [BROWSER-CHAT-03 / @plan-30-05]", async ({ request }) => {
    // The MCP bridge is token-gated. The Playwright process shares the spawned
    // test server's env, so read the SAME token it was started with (falls back
    // to the start-test-server.sh default).
    const gw = {
      "Content-Type": "application/json",
      "x-gateway-token": process.env.GATEWAY_TOKEN ?? "test-token",
    };
    const topic = await createTopic(request, `E2E-AnyTab-${Date.now()}`);
    const ctxId = topic.id;
    // A session that owns NO pane of its own — it must still be able to list and
    // drive OTHER tabs. `own` resolves to null for this bogus session key.
    const lister = `e2e-lister-${Date.now()}`;
    try {
      // Open a browser pane for topic A (creates a CDP context browserService tracks).
      const openRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/open`, {
        data: { url: "https://example.com" },
        headers: { "Content-Type": "application/json" },
      });
      expect(openRes.ok()).toBe(true);

      // list-tabs from the pane-less lister session surfaces topic A's tab.
      const listRes = await request.post(`${BASE}/api/sessions/${lister}/browser/list-tabs`, {
        data: {}, headers: gw,
      });
      expect(listRes.ok()).toBe(true);
      const { tabs } = (await listRes.json()) as {
        tabs: Array<{ contextId: string; url: string; label: string; kind: string; isOwn: boolean }>;
      };
      const a = tabs.find((t) => t.contextId === ctxId);
      expect(a).toBeTruthy();
      expect(a!.kind).toBe("topic");
      expect(a!.label).toBe(topic.name);
      expect(a!.url).toMatch(/example\.com/);
      expect(a!.isOwn).toBe(false); // not the lister's own pane

      // Cross-session drive: get-text against topic A via the contextId override.
      const txtRes = await request.post(`${BASE}/api/sessions/${lister}/browser/get-text`, {
        data: { contextId: ctxId }, headers: gw,
      });
      expect(txtRes.ok()).toBe(true);
      const txt = (await txtRes.json()) as { text?: string };
      expect(typeof txt.text).toBe("string");
      expect(txt.text!.length).toBeGreaterThan(0);

      // An unknown contextId is rejected (never upserts a phantom context) and
      // the error lists the live ids so the agent can recover.
      const bogusRes = await request.post(`${BASE}/api/sessions/${lister}/browser/get-text`, {
        data: { contextId: "nope-does-not-exist" }, headers: gw,
      });
      expect(bogusRes.status()).toBe(404);
      const bogus = (await bogusRes.json()) as { error?: string };
      expect(bogus.error).toMatch(/unknown contextId/i);
      expect(bogus.error).toContain(ctxId);
    } finally {
      await request.delete(`${BASE}/api/browsers/${ctxId}`).catch(() => {});
      await deleteTopic(request, ctxId).catch(() => {});
    }
  });

  test("OpenClaw bridge removed - 4 grep gates return 0 [BROWSER-CHAT-03 / @plan-30-05]", async () => {
    const src = readFileSync("server/routes/topics.ts", "utf-8");
    expect((src.match(/browserTargetIdCache/g) ?? []).length).toBe(0);
    expect((src.match(/BROWSER ISOLATION/g) ?? []).length).toBe(0);
    expect((src.match(/isolationInstruction/g) ?? []).length).toBe(0);
    expect((src.match(/BrowserIsolation/g) ?? []).length).toBe(0);
  });

  test("browser_point: Moondream failsoft returns structured error (route-mocked) [BROWSER-CHAT-03 / @plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    // W9 FIX: bound the test to 60s (Moondream client has 15s AbortSignal).
    test.setTimeout(60000);

    // W9 FIX: install route mock for completeness. NOTE: page.route only
    // intercepts BROWSER traffic; the Moondream client runs server-side
    // (Bun fetch), so this mock primarily exists to document intent.
    // The deterministic failsoft branch fires when MOONDREAM_API_KEY is
    // unset on the test server (default for global-setup-spawned server).
    await browserProcessPageV2.mockMoondream(async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unauthorized' }),
      });
    });

    const topic = await createTopic(request, `E2E-Moondream-${Date.now()}`);
    const ctxId = topic.id;
    try {
      // Open first so the handler can hit the screenshot+point flow.
      await request.post(`${BASE}/api/browsers/${ctxId}/agent/open`, {
        data: { url: "https://example.com" },
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      });

      const res = await request.post(`${BASE}/api/browsers/${ctxId}/agent/point`, {
        data: { description: "the example link" },
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      });
      expect([200, 500]).toContain(res.status());
      const body = (await res.json()) as {
        error?: string;
        clicked?: boolean;
        point?: { x: number; y: number };
      };

      // Two acceptable failsoft branches:
      //   A) Server-side network/auth failsoft (MOONDREAM_API_KEY unset
      //      OR network 401 -> handler returns structured error)
      //   B) Unexpected success (route mock didn't fire and key was set)
      if (body.error) {
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.error).toMatch(/MOONDREAM|Vision fallback|unauthorized|401|network|auth|budget|Bad Request/i);
      } else {
        expect(body.clicked).toBe(true);
        expect(typeof body.point?.x).toBe("number");
        expect(typeof body.point?.y).toBe("number");
      }
    } finally {
      await request.delete(`${BASE}/api/browsers/${ctxId}`).catch(() => {});
      await deleteTopic(request, ctxId).catch(() => {});
    }
  });
});
