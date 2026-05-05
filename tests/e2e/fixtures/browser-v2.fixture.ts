import { test as base, type Page } from "@playwright/test";
import { BrowserProcessPage } from "./browser.fixture";

/**
 * Phase 30 BROWSER-CHAT-02 fixture extension.
 *
 * Extends BrowserProcessPage (phase 27) with WebSocket-aware mocks for the
 * new /ws/browser/:contextId bridge. Plan 30-02 owns ONLY the WS mocks here;
 * tool-agent mocks (Moondream client, agent_active broadcasts) belong to
 * the 30-03 fixture extension.
 *
 * Status: Wave-0 stub. The .mockBrowserWs() implementation is filled in
 * during plan 30-05 (when the spec assertions land).
 */
export class BrowserProcessPageV2 extends BrowserProcessPage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Mock the /ws/browser/:contextId endpoint via page.routeWebSocket.
   * Replays a deterministic frame sequence on connect + records inbound
   * input messages for assertions. Filled in plan 30-05.
   */
  async mockBrowserWs(_opts?: {
    framesPerSecond?: number;       // default 15 (Nyquist target)
    framePayloadBase64?: string;    // default tiny 1x1 jpeg
    autoCloseAfterMs?: number;      // simulate disconnect for fallback test
  }): Promise<void> {
    // Wave-0 stub. Implementation pending — see plan 30-05.
    // Will use this.page.routeWebSocket("**/ws/browser/*", async (ws) => { ... }).
    return;
  }

  /**
   * Drain the recorded inbound input messages (client to server). Filled
   * with the recording array populated by mockBrowserWs.
   */
  drainInputMessages(): unknown[] {
    // Wave-0 stub.
    return [];
  }
}

export const test = base.extend<{ browserProcessPageV2: BrowserProcessPageV2 }>({
  browserProcessPageV2: async ({ page }, use) => {
    await use(new BrowserProcessPageV2(page));
  },
});
