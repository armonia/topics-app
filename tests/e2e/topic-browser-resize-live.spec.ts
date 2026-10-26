import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic, waitForTopicVisible, resetPaneStore, closeAllBrowserContexts } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Hermetic boundary: this file restarts from the globalSetup baseline, not from
// whatever the previous specs left behind. See fixtures/hermetic.ts.
hermetic(test);

test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

/**
 * Dragging the border of the topic's browser window, the PAGE follows the hand.
 *
 * `topic-browser-window` (01v/01w) proves that the window and the chat follow
 * the pointer, and nothing about the page inside: the pane measured itself
 * with a ResizeObserver and sent the size after a 150 ms debounce, so as long
 * as the hand kept moving the remote page kept its old width and reflowed
 * only once the drag stopped. Here the width is read where it is true, from
 * the headless page itself (`/api/browsers/:id/agent/eval`), WHILE the button
 * is still down: two different values of `window.innerWidth` before the
 * mouseup, which no debounce longer than the gap between two moves can give.
 *
 * THIS FILE IS OUT OF THE PR GATE (`NIGHTLY_ONLY_SPECS`), for the family's
 * reason: the server has to launch a headless Chromium for the page, and under
 * the gate's shards that launch times out. See `browser-viewport-arbiter`.
 *
 * @covers TOPIC-BROWSER-01
 */

async function seedWindow(request: APIRequestContext, topicId: string, value: Record<string, unknown>): Promise<void> {
  const res = await request.put(`${E2E_BASE}/api/ui-state/topic-browser:${topicId}`, {
    data: value,
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBeTruthy();
}

/** The width the headless page REALLY has, not the one it was asked for. */
async function remoteWidth(request: APIRequestContext, contextId: string): Promise<number | null> {
  const res = await request.post(`${E2E_BASE}/api/browsers/${encodeURIComponent(contextId)}/agent/eval`, {
    data: { expression: "window.innerWidth" },
    timeout: 60_000,
  }).catch(() => null);
  if (!res?.ok()) return null;
  const body = (await res.json()) as { result?: unknown };
  const n = Number(body.result);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function paneWidth(page: Page): Promise<number> {
  const box = await page.locator('[data-testid="topic-browser-window"]').boundingBox();
  return box?.width ?? 0;
}

test.describe("TOPIC-BROWSER-01 la pagina della finestra segue il trascinamento", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "TOPIC-BROWSER-01" });
    await resetPaneStore(request, []);
  });

  test("TOPIC-BROWSER-01x: espansa, la pagina remota cambia larghezza durante il trascinamento, non solo al rilascio", async ({ page, request }) => {
    // The server launches a headless Chromium for the page: see the file docstring.
    test.setTimeout(180_000);
    const contextId = `tbw-live-remote-${Date.now()}`;
    const topic = await createTopic(request, `E2E-TBW-LiveRemote-${Date.now()}`);
    try {
      await seedWindow(request, topic.id, {
        mode: "exp", minPos: null, expandedWidth: 420,
        tabs: [{ contextId, url: "about:blank", title: "Blank", openedBy: "user" }],
        activeContextId: contextId, promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page.locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`).first().click();
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toHaveAttribute("data-mode", "exp", { timeout: 10_000 });

      // The page exists and already has the pane's width (at rest, any debounce gets there).
      const start = await expect
        .poll(() => remoteWidth(request, contextId), { timeout: 120_000, message: "la pagina remota non e' mai partita" })
        .toBeGreaterThan(200)
        .then(() => remoteWidth(request, contextId));
      expect(start).not.toBeNull();

      const handle = (await page.locator('[data-testid="topic-browser-resize-handle"]').boundingBox())!;
      const grabX = handle.x + handle.width / 2;
      const grabY = handle.y + handle.height / 2;
      await page.mouse.move(grabX, grabY);
      await page.mouse.down();

      // The hand never stops: a 2 px move after another, back and forth over
      // 200 px, so the gap between two size changes is a few milliseconds,
      // far under any debounce. Meanwhile the page is asked its width.
      const seen = new Set<number>();
      let dragging = true;
      const deadline = Date.now() + 20_000;
      const hand = (async () => {
        let dx = 0;
        let dir = -1;
        while (dragging && Date.now() < deadline) {
          dx += 2 * dir;
          if (dx <= -200 || dx >= 0) dir = -dir;
          await page.mouse.move(grabX + dx, grabY);
        }
      })();
      const reader = (async () => {
        while (Date.now() < deadline && seen.size < 2) {
          const w = await remoteWidth(request, contextId);
          if (w !== null) seen.add(w);
        }
        dragging = false;
      })();
      await reader;
      await hand;
      const duringDrag = [...seen];
      await page.mouse.up();

      expect(
        duringDrag.length,
        `col tasto ancora premuto la pagina remota ha avuto solo queste larghezze: ${duringDrag.join(", ")} (a riposo ${start})`,
      ).toBeGreaterThanOrEqual(2);
      // And the last size leaves too: at rest the page is as wide as the pane.
      const finalPane = await paneWidth(page);
      await expect
        .poll(() => remoteWidth(request, contextId), { timeout: 10_000 })
        .toBeGreaterThan(finalPane - 40);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
