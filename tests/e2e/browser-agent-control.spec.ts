import { test, expect } from "@playwright/test";

test.describe("BROWSER-CHAT-03 Agent control + native browser tools (@plan-30-03)", () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "BROWSER-CHAT-03" });
    testInfo.annotations.push({ type: "plan", description: "@plan-30-03" });
  });

  // Implemented in plan 30-05. Stub guarantees the spec file exists for the
  // validation pipeline + grep-based plan discovery.
  test.fixme(
    "agent invokes browser_open via REST -> navigation reflected in /ws/browser frame within 2s [BROWSER-CHAT-03 / @plan-30-03]",
    async ({ page: _page, request: _request }) => {
      test.info().annotations.push({ type: "spec", description: "BROWSER-CHAT-03" });
      test.info().annotations.push({ type: "plan", description: "@plan-30-03" });
      // 1. Spawn a fresh browser context (any contextId).
      // 2. Open WS to /ws/browser/:contextId via page.routeWebSocket spy.
      // 3. POST /api/browsers/:contextId/agent/open with { url: 'https://example.com' }.
      // 4. Assert response is 200 with { url, title } shape.
      // 5. Assert: a 'frame' or 'nav' WS message containing the new URL arrives within 2000ms.
      expect(true).toBe(true);
    }
  );

  test.fixme(
    "browser_observe returns >=1 indexed element + base64 annotated screenshot [BROWSER-CHAT-03 / @plan-30-03]",
    async ({ page: _page, request: _request }) => {
      test.info().annotations.push({ type: "spec", description: "BROWSER-CHAT-03" });
      test.info().annotations.push({ type: "plan", description: "@plan-30-03" });
      // 1. POST /api/browsers/:id/agent/open with { url: 'https://example.com' }.
      // 2. POST /api/browsers/:id/agent/observe with {}.
      // 3. Assert response.elements.length >= 1.
      // 4. Assert response.screenshot_annotated is base64 (matches /^[A-Za-z0-9+/=]+$/) and decodes to a non-empty buffer.
      // 5. Assert response.elements[0] has { id: number, role: string, name: string, bbox: { x, y, width, height } }.
      // 6. Assert response.url and response.title are non-empty strings.
      expect(true).toBe(true);
    }
  );

  test.fixme(
    "agent_active broadcast: WS receives { type: 'agent_active', active: true } before tool call and { active: false } after (guaranteed even on error) [BROWSER-CHAT-03 / @plan-30-03]",
    async ({ page: _page, request: _request }) => {
      test.info().annotations.push({ type: "spec", description: "BROWSER-CHAT-03" });
      test.info().annotations.push({ type: "plan", description: "@plan-30-03" });
      // 1. Open WS to /ws/browser/:id and start recording all incoming agent_active messages.
      // 2. POST /api/browsers/:id/agent/act with an INVALID element_id (forces handler error).
      // 3. Capture all agent_active frames received during the call.
      // 4. Assert sequence: [{ active: true }, { active: false }] in that order.
      // 5. Assert finally-block lock release works even when the action throws.
      expect(true).toBe(true);
    }
  );

  test.fixme(
    "OpenClaw bridge removed -- grep server/routes/topics.ts returns 0 for browserTargetIdCache + BROWSER ISOLATION + isolationInstruction + BrowserIsolation [BROWSER-CHAT-03 / @plan-30-03]",
    async () => {
      test.info().annotations.push({ type: "spec", description: "BROWSER-CHAT-03" });
      test.info().annotations.push({ type: "plan", description: "@plan-30-03" });
      // Source-level invariant test. Refactor-resistant alternative for plan 30-05:
      // start a chat session, capture all system messages emitted to the LLM via the
      // providers' streaming pipeline, assert NO message contains 'BROWSER ISOLATION:'.
      const { readFileSync } = await import("fs");
      const src = readFileSync("server/routes/topics.ts", "utf-8");
      expect((src.match(/browserTargetIdCache/g) ?? []).length).toBe(0);
      expect((src.match(/BROWSER ISOLATION/g) ?? []).length).toBe(0);
      expect((src.match(/isolationInstruction/g) ?? []).length).toBe(0);
      expect((src.match(/BrowserIsolation/g) ?? []).length).toBe(0);
    }
  );

  test.fixme(
    "browser_point Moondream fallback: when MOONDREAM_API_KEY unset, returns structured error containing 'MOONDREAM_API_KEY' [BROWSER-CHAT-03 / @plan-30-03]",
    async ({ request: _request }) => {
      test.info().annotations.push({ type: "spec", description: "BROWSER-CHAT-03" });
      test.info().annotations.push({ type: "plan", description: "@plan-30-03" });
      // 1. Ensure MOONDREAM_API_KEY env is unset for this test (or use a fixture).
      // 2. POST /api/browsers/:id/agent/point with { description: 'the example link' }.
      // 3. Assert response is 200 with body.error matching /MOONDREAM_API_KEY/.
      // 4. Assert no crash, no further HTTP error.
      expect(true).toBe(true);
    }
  );
});
