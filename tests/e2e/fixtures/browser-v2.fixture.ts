import { test as base, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { BrowserProcessPage } from "./browser.fixture";

/**
 * Phase 30 BROWSER-CHAT-02..04 fixture extension.
 *
 * Extends BrowserProcessPage (phase 27) with WebSocket-aware mocks for the
 * /ws/browser/:contextId bridge plus tool-agent / select-element helpers
 * used by plans 30-02..30-05 spec files.
 *
 * Status: Wave-0 stubs filled in plan 30-05.
 */
export class BrowserProcessPageV2 extends BrowserProcessPage {
  // Active WS route reference; set by mockBrowserWs, used by closeWs +
  // broadcastAgentActive helpers. Public so tests don't need a getter.
  private wsRouteRef: WebSocketRoute | null = null;

  // Number of times the client has (re)connected to /ws/browser/ — the mock's
  // routeWebSocket handler runs once per connection. A reconnect after closeWs()
  // increments this, which is how the reconnect test observes recovery without
  // racing the connection-indicator class.
  private wsConnectCount = 0;

  // Inbound (client -> server) messages recorded when mockBrowserWs is
  // configured with recordInbound (default true).
  private recordedInboundMessages: unknown[] = [];

  // Whether mockMoondream has installed its page.route guard yet (avoid
  // duplicate installs across multiple test calls).
  private moondreamInterceptInstalled = false;

  constructor(page: Page) {
    super(page);
  }

  /**
   * Mock the /ws/browser/:contextId endpoint via page.routeWebSocket.
   * Replays a deterministic frame sequence on connect + records inbound
   * input messages for assertions.
   *
   * Usage:
   *   await fixture.mockBrowserWs();                           // 15 fps default frames
   *   await fixture.mockBrowserWs({ framesPerSecond: 30 });    // tighter window
   *   await fixture.mockBrowserWs({ autoCloseAfterMs: 1500 }); // simulate WS drop
   */
  async mockBrowserWs(opts?: {
    framesPerSecond?: number;       // default 15
    framePayloadBase64?: string;    // default tiny 1x1 jpeg
    autoCloseAfterMs?: number;      // simulate disconnect
    recordInbound?: boolean;        // default true — record client -> server messages
  }): Promise<void> {
    const fps = opts?.framesPerSecond ?? 15;
    const intervalMs = Math.max(1, Math.round(1000 / fps));
    // tiny 1x1 jpeg base64 fallback (realistic frame payload, ~150 bytes)
    const frameB64 = opts?.framePayloadBase64
      ?? '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AP8An/8A/9k=';
    this.recordedInboundMessages = [];
    this.wsConnectCount = 0;
    const recordInbound = opts?.recordInbound !== false;

    await this.page.routeWebSocket(/\/ws\/browser\//, async (ws) => {
      this.wsRouteRef = ws;
      this.wsConnectCount += 1;
      if (recordInbound) {
        ws.onMessage((msg) => {
          try {
            const parsed = JSON.parse(String(msg));
            this.recordedInboundMessages.push(parsed);
          } catch {
            this.recordedInboundMessages.push(String(msg));
          }
        });
      }
      // Send first frame within ~50ms (well under 500ms target)
      setTimeout(() => {
        try {
          ws.send(JSON.stringify({
            type: 'frame',
            data: frameB64,
            metadata: { pageScaleFactor: 1, timestamp: Date.now() },
          }));
        } catch { /* ignore */ }
      }, 50);
      // Push frames at fps rate
      const interval = setInterval(() => {
        try {
          ws.send(JSON.stringify({
            type: 'frame',
            data: frameB64,
            metadata: { pageScaleFactor: 1, timestamp: Date.now() },
          }));
        } catch {
          clearInterval(interval);
        }
      }, intervalMs);
      if (opts?.autoCloseAfterMs) {
        setTimeout(() => {
          clearInterval(interval);
          try { ws.close(); } catch { /* ignore */ }
        }, opts.autoCloseAfterMs);
      }
    });
  }

  /**
   * Drain the recorded inbound input messages (client -> server). Returns a
   * snapshot copy and clears the buffer for the next assertion window.
   */
  drainInputMessages(): unknown[] {
    const drained = [...this.recordedInboundMessages];
    this.recordedInboundMessages = [];
    return drained;
  }

  /**
   * Force-close the active WS route (simulates a transient server drop). The
   * client auto-reconnects — routeWebSocket re-accepts the next connection — so
   * the pane returns to live. To test the fallback-http FLOOR (no reconnect),
   * make the WebSocket constructor throw instead (see the fallback spec).
   */
  closeWs(): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    try { this.wsRouteRef.close(); } catch { /* ignore */ }
    this.wsRouteRef = null;
  }

  /** How many times the client has (re)connected to /ws/browser/ so far. */
  getWsConnectCount(): number {
    return this.wsConnectCount;
  }

  /** Send a synthetic download message over the active WS route. */
  sendDownload(info: { filename: string; href: string; size?: number; state: 'started' | 'completed' | 'failed' }): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    this.wsRouteRef.send(JSON.stringify({ type: 'download', ...info }));
  }

  /** Send a synthetic console message over the active WS route. */
  sendConsole(level: 'log' | 'warn' | 'error', text: string): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    this.wsRouteRef.send(JSON.stringify({ type: 'console', level, text }));
  }

  /**
   * Mock the Moondream cloud API endpoint via page.route.
   * If `handler` is null/undefined, returns the default success shape (one
   * point at center).
   *
   * NOTE: page.route intercepts BROWSER-side fetches. The Moondream client
   * runs server-side (Bun), so this mock fires only when a test triggers
   * the call from the page context. For server-side dispatch, the failsoft
   * branch fires when MOONDREAM_API_KEY is unset (test server default).
   *
   * Useful patterns:
   *   - mockMoondream() — success path with default point
   *   - mockMoondream(async (route) => route.fulfill({status: 401, body: 'no auth'}))
   *   - mockMoondream(async (route) => route.fulfill({status: 200, body: '{"points":[]}'}))
   */
  async mockMoondream(handler?: (route: Route) => Promise<void> | void): Promise<void> {
    if (this.moondreamInterceptInstalled) return;
    this.moondreamInterceptInstalled = true;
    await this.page.route(/api\.moondream\.ai\/v1\/point/, async (route) => {
      if (handler) {
        await handler(route);
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ points: [{ x: 0.5, y: 0.5 }] }),
        });
      }
    });
  }

  /**
   * Mock POST /api/browsers/:id/inspect with deterministic DOM info.
   * Used by Cmd+Shift+E select-element tests.
   *
   * IMPORTANT — bbox shape MUST match production
   * (server/browser-service.ts:953 resolveElementAtPoint +
   * client/src/components/Browser/SelectElementOverlay.tsx:71 consumer):
   * { x, y, w, h } — NOT { x, y, width, height }. The overlay reads bbox.w
   * and bbox.h directly; using width/height would render zero-sized boxes.
   */
  async mockInspect(canned: {
    path: string;
    cssPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text?: string;
  }): Promise<void> {
    await this.page.route(/\/api\/browsers\/[^/]+\/inspect$/, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(canned),
        });
      } else {
        await route.fallback();
      }
    });
  }

  /**
   * Send a synthetic agent_active broadcast over the active WS route,
   * simulating an LLM tool call entry/exit. Used by overlay/lock tests
   * that don't need a real provider in the loop. Does NOT actually invoke
   * a handler.
   *
   * Pair true -> false to close the cycle.
   */
  broadcastAgentActive(active = true): void {
    if (!this.wsRouteRef) throw new Error('mockBrowserWs() must be called first');
    this.wsRouteRef.send(JSON.stringify({ type: 'agent_active', active }));
  }

  /**
   * Intercept the provider's outbound HTTP request (api.anthropic.com or
   * api.openai.com) and capture options.tools as sent. Returns a promise
   * that resolves once the provider has been called.
   *
   * Use BEFORE the chat send is triggered. Pair with the user typing
   * `@browser ...` in the chat input.
   */
  async assertProviderToolsPassed(
    providerName: 'anthropic' | 'openai',
  ): Promise<{ tools: { name: string }[] }> {
    const urlPattern = providerName === 'anthropic'
      ? /api\.anthropic\.com\/v1\/messages/
      : /api\.openai\.com\/v1\/chat\/completions/;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No ${providerName} request captured`)),
        15000,
      );
      this.page.route(urlPattern, async (route) => {
        try {
          const body = JSON.parse(route.request().postData() || '{}');
          clearTimeout(timeout);
          // Anthropic: body.tools = [{name, ...}];
          // OpenAI: body.tools = [{type:'function', function:{name, ...}}]
          const tools: { name: string }[] = (body.tools ?? []).map(
            (t: { name?: string; function?: { name?: string } }) => ({
              name: t.name ?? t.function?.name ?? '',
            }),
          );
          resolve({ tools });
          // Fulfill with a minimal response so the provider doesn't 5xx the test
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              content: [{ type: 'text', text: 'mocked' }],
              stop_reason: 'end_turn',
            }),
          });
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }
}

export const test = base.extend<{ browserProcessPageV2: BrowserProcessPageV2 }>({
  browserProcessPageV2: async ({ page }, use) => {
    await use(new BrowserProcessPageV2(page));
  },
});

export { expect } from "@playwright/test";
