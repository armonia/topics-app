/**
 * Multi-client ("two devices") E2E primitive.
 *
 * Cross-device features (a Mac app + a PWA/web tab syncing over the server)
 * cannot be verified from a single page — the whole point is that an action on
 * ONE client shows up on ANOTHER. Playwright models a "device" as an independent
 * `browser.newContext()`: fresh cookies + fresh localStorage + a distinct
 * `X-Client-Id`, so the two contexts share NOTHING locally and can only converge
 * through the real server (the `ui_state` WebSocket channel). That is exactly the
 * Mac-app ↔ PWA topology.
 *
 * `openTwoDevices` is the reusable harness the cross-device specs build on:
 * it opens two such contexts against the shared test server, (optionally) seeds
 * shared server state BEFORE either client loads — so fresh, empty-localStorage
 * contexts hydrate purely from the server with no last-write-wins race against a
 * live client — then loads the app in both and (optionally) waits for both WS
 * connections to come up.
 */
import type { Browser, BrowserContext, Page, APIRequestContext, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import { goToApp } from "../helpers";
import { E2E_BASE } from "./test-server";

const BASE_URL = E2E_BASE;
// The per-context browser STREAM socket (headless Chromium fan-out). Distinct
// from the app-wide sync socket `/ws` — this regex never matches `/ws` itself,
// so stubbing it leaves pane/tombstone sync fully real.
const BROWSER_STREAM_WS = /\/ws\/browser\//;

export interface TwoDevices {
  /** "Mac app" — the client that acts. */
  ctxA: BrowserContext;
  pageA: Page;
  /** "PWA / web" — the client that must observe the effect. */
  ctxB: BrowserContext;
  pageB: Page;
  /** Close both contexts. Call in a `finally`. */
  dispose(): Promise<void>;
}

export interface OpenTwoDevicesOptions {
  /**
   * Intercept the `/ws/browser/<ctx>` stream socket on BOTH pages so a seeded
   * `browser:` pane renders its TAB without the server launching a real headless
   * Chromium. The browser engine is the one external boundary we isolate
   * (CLAUDE.md: "mock only external boundaries"); the app socket `/ws` — where
   * pane + tombstone sync lives — is left real. Default: true.
   */
  stubBrowserStream?: boolean;
  /** Assert `connection-status` is visible on both before returning. Default: true. */
  waitConnected?: boolean;
  /**
   * Seed shared server state before the first load. Runs AFTER the contexts
   * exist (so `request` works) but BEFORE `goToApp`, so both fresh contexts
   * hydrate it deterministically. Receives device A's request context.
   */
  seed?: (request: APIRequestContext) => Promise<void>;
}

export async function openTwoDevices(
  browser: Browser,
  opts: OpenTwoDevicesOptions = {},
): Promise<TwoDevices> {
  const { stubBrowserStream = true, waitConnected = true, seed } = opts;

  const ctxA = await browser.newContext({ baseURL: BASE_URL });
  const ctxB = await browser.newContext({ baseURL: BASE_URL });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Route mocks must be registered BEFORE navigation. A no-op handler connects
  // the client socket locally and never forwards to the server → no Chromium.
  if (stubBrowserStream) {
    for (const p of [pageA, pageB]) {
      await p.routeWebSocket(BROWSER_STREAM_WS, () => { /* swallow: no server, no frames */ });
    }
  }

  // Seed the shared server BEFORE the first client load (see option docstring).
  if (seed) await seed(pageA.request);

  await goToApp(pageA);
  await goToApp(pageB);

  if (waitConnected) {
    await expect(pageA.locator('[data-testid="connection-status"]')).toBeVisible({ timeout: 10000 });
    await expect(pageB.locator('[data-testid="connection-status"]')).toBeVisible({ timeout: 10000 });
  }

  return {
    ctxA, pageA, ctxB, pageB,
    async dispose() {
      await ctxA.close().catch(() => { /* best-effort */ });
      await ctxB.close().catch(() => { /* best-effort */ });
    },
  };
}

/** Locator for a pane's TAB (in any tab bar) by pane id. `data-pane-id` is set
 *  only on tab elements (PaneTabBar), so `toHaveCount(0)` means the tab is gone. */
export function tabFor(page: Page, paneId: string): Locator {
  return page.locator(`[data-pane-id="${paneId}"]`);
}

/**
 * Close a pane through its tab's X, exactly like a user. Hovers the tab to
 * reveal the (hover-only) close affordance, then clicks it — driving the REAL
 * deferred-close path (PendingAction countdown → CLOSE_PANE + the per-kind
 * side effect, e.g. the browser close-tombstone), not an API shortcut.
 */
export async function closeTabViaX(page: Page, paneId: string): Promise<void> {
  const tab = tabFor(page, paneId).first();
  await tab.hover();
  // Scoped to the TAB, not matched by aria-label: that label carries the human
  // name of the chat now (a screen reader announcing an id is announcing
  // nothing), so the id is no longer in it. `data-testid` inside the tab is the
  // stable handle and does not move when the chat is renamed.
  await tab.locator('[data-testid="pane-tab-close"]').first().click();
}
