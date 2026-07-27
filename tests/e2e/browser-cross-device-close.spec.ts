import { test, expect } from "@playwright/test";
import { openTwoDevices, tabFor, closeTabViaX } from "./helpers/multi-client";
import { resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

/**
 * Cross-device browser-tab close — the "l'ho chiusa da app, ma sta ancora su
 * pwa" bug. A browser tab closed on one device (the Mac app) must disappear on
 * the other (the PWA) LIVE, without a reload.
 *
 * WHY this needs its own spec: the pane-store `pane-store-v2` live broadcast
 * reconciles cross-device with a UNION (so one client can't wipe another's
 * tabs) — which means a REMOVAL on A does NOT propagate to B live. Cross-device
 * CLOSES ride a separate rail: A records a `tombstones-browser` close-marker,
 * it syncs over `/ws`, and B's `evictRemotelyClosedBrowserPanes` dispatches
 * CLOSE_PANE for the matching `browser:<ctx>` pane. Two links had to be right:
 *   1. the GLOBAL close path (usePaneLifecycle) must WRITE that tombstone — it
 *      only did so for project-inner tabs before, the gap behind the bug;
 *   2. the peer must EVICT on receipt, not merely stop resurrecting on reload.
 * This spec exercises both over two real clients, driving the close through the
 * actual tab X (the deferred-close path), asserting on the peer's live DOM.
 *
 * Deterministic: the browser STREAM socket is stubbed (openTwoDevices) so no
 * real headless Chromium is involved — only the pane-store + tombstone sync,
 * which is what the fix touches.
 */
const BASE = E2E_BASE;

test.describe("Cross-device browser tab close (tombstone eviction)", () => {
  test("CD-CLOSE-01: a browser tab closed on device A disappears LIVE on device B", async ({ browser }) => {
    test.info().annotations.push({ type: "spec", description: "CD-CLOSE-01" });
    const stamp = Date.now();
    const closePane = `browser:e2e-cdclose-${stamp}`;
    const keepPane = `browser:e2e-cdkeep-${stamp}`;

    // Two devices; seed BOTH browser panes into the shared store before either
    // loads, so each fresh context hydrates the two browser tabs from the server.
    const dev = await openTwoDevices(browser, {
      seed: (request) => resetPaneStore(request, [keepPane, closePane]),
    });

    try {
      // Device B (the "PWA") shows both browser tabs.
      await expect(tabFor(dev.pageB, closePane).first()).toBeVisible({ timeout: 10000 });
      await expect(tabFor(dev.pageB, keepPane).first()).toBeVisible({ timeout: 10000 });

      // Device A (the "Mac") closes ONE browser tab via its X (real deferred close).
      await closeTabViaX(dev.pageA, closePane);

      // THE FIX: device B evicts that pane LIVE — no reload. The close-tombstone
      // synced over /ws and evictRemotelyClosedBrowserPanes ran CLOSE_PANE.
      await expect(tabFor(dev.pageB, closePane)).toHaveCount(0, { timeout: 15000 });
      // Targeted, not a blanket wipe: the sibling browser tab must survive.
      await expect(tabFor(dev.pageB, keepPane).first()).toBeVisible();
    } finally {
      await dev.dispose();
    }
  });

  test("CD-CLOSE-02: closing a browser tab publishes its tombstone to the shared channel", async ({ browser }) => {
    test.info().annotations.push({ type: "spec", description: "CD-CLOSE-02" });
    const stamp = Date.now();
    const ctxId = `e2e-cdpub-${stamp}`;
    const closePane = `browser:${ctxId}`;

    const dev = await openTwoDevices(browser, {
      seed: (request) => resetPaneStore(request, [closePane]),
    });

    try {
      await expect(tabFor(dev.pageA, closePane).first()).toBeVisible({ timeout: 10000 });

      // Close the GLOBAL browser tab. usePaneLifecycle's browser side-effect must
      // write the cross-device tombstone — the link that was missing for global
      // (non-project) tabs, which is what left the tab stuck on the PWA.
      await closeTabViaX(dev.pageA, closePane);

      // Poll the shared ui_state key until it lists this context.
      await expect
        .poll(
          async () => {
            const res = await dev.pageA.request.get(`${BASE}/api/ui-state/tombstones-browser`, { ignoreHTTPSErrors: true });
            if (!res.ok()) return [] as string[];
            const body = (await res.json().catch(() => null)) as { value?: { entries?: Array<{ id?: string }> } } | null;
            return (body?.value?.entries ?? []).map((e) => e.id ?? "");
          },
          { timeout: 15000 },
        )
        .toContain(ctxId);
    } finally {
      await dev.dispose();
    }
  });
});
