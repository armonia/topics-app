/**
 * REPOSITIONING A TAB MUST NOT RELOAD THE PANE.
 *
 * The report: dragging a tab to another position shows the pane's loader for a
 * moment. The cause is not a fetch, it is the DOM. Every visited pane keeps its
 * own shell mounted (`PaneKeepAlive`, `[data-pane-shell]`) and the shells were
 * rendered in TAB ORDER, so reordering the tabs reordered the sibling nodes:
 * React answers a reorder with `insertBefore`, which is a detach plus a
 * re-attach. A detached iframe destroys and rebuilds its browsing context (the
 * page reloads, which is the loader you see) and a detached scroller loses its
 * scroll position.
 *
 * What this spec watches, from inside the page, across one real drag:
 *   1. iframe `load` events  - a browser pane reloading its document;
 *   2. pane-shell detachments - the shells being moved in the DOM at all;
 *   3. spinners appearing    - the loader, as the eye sees it.
 *
 * @covers LAYOUT-01
 */
import { test, expect } from "./fixtures/browser-v2.fixture";
import type { Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, closeAllBrowserContexts } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Same-origin page for the mocked browser panes: no network in a hermetic suite. */
const URL_PANE = `${E2E_BASE}/changelog.json`;

let t1 = "";
let t2 = "";

interface ReloadProbe {
  iframeLoads: number;
  iframeMounts: number;
  shellDetaches: number;
  spinners: number;
}

/** Per pane, so the reading tells apart "the pane that moved" from "the panes that stayed". */
type ProbeByPane = Record<string, ReloadProbe>;

/**
 * Installs the probe. It must be armed BEFORE the gesture, and it only counts
 * what happens after that moment: the initial loads of the iframes and the
 * spinners of the first paint are not the subject. Every count is filed under
 * the pane shell that owns the node.
 */
async function armProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state: Record<string, { iframeLoads: number; iframeMounts: number; shellDetaches: number; spinners: number }> = {};
    (window as unknown as Record<string, unknown>).__reloadProbe = state;
    const bucket = (key: string) => (state[key] ??= { iframeLoads: 0, iframeMounts: 0, shellDetaches: 0, spinners: 0 });
    const owner = (node: Element | null): string =>
      node?.closest("[data-pane-shell]")?.getAttribute("data-pane-shell") || "unattached";

    // A LOADER THE USER COULD SEE, not a loader node that exists.
    //
    // The browser frame lives in a layer of its own now
    // (`components/Browser/hostedIframe`) and keeps painting the live page
    // straight through a group change. The pane underneath still rebuilds, and
    // while it works out its URL it renders its connecting state - behind the
    // page, covered by it, never shown. Counting that would fail a pane that
    // flashed nothing.
    //
    // The check is the honest one and it is STRICTER where it matters: hit-test
    // the middle of the loader and ask what is actually on top. If the frame ever
    // stops covering it - the layer hidden a frame too early, the wrong rectangle,
    // a z-index regression - the topmost element is the loader itself and this
    // counts it. Zero-area means nothing was painted either.
    const coveredByFrame = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return true;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top?.closest("[data-browser-frame-layer]");
    };

    // A MOVED iframe keeps its element, so this listener survives and fires
    // again on re-attach; a REMOUNTED one is a new element, counted below.
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      const key = owner(frame);
      frame.addEventListener("load", () => { bucket(key).iframeLoads += 1; });
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof HTMLElement && node.hasAttribute("data-pane-shell")) {
            bucket(node.getAttribute("data-pane-shell") || "unattached").shellDetaches += 1;
          }
        }
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          const key = node.hasAttribute("data-pane-shell")
            ? node.getAttribute("data-pane-shell") || "unattached"
            : owner(node.parentElement);
          if (node.tagName === "IFRAME" || node.querySelector("iframe")) bucket(key).iframeMounts += 1;
          const spinner = node.classList.contains("animate-spin")
            ? node
            : node.querySelector(".animate-spin");
          if (spinner && !coveredByFrame(spinner)) bucket(key).spinners += 1;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

async function readProbe(page: Page): Promise<ProbeByPane> {
  return page.evaluate(() => (window as unknown as { __reloadProbe: ProbeByPane }).__reloadProbe);
}

/** What the probe recorded for one pane - all zeros when nothing happened to it. */
function forPane(probe: ProbeByPane, key: string): ReloadProbe {
  return probe[key] ?? { iframeLoads: 0, iframeMounts: 0, shellDetaches: 0, spinners: 0 };
}

const UNDISTURBED: ReloadProbe = { iframeLoads: 0, iframeMounts: 0, shellDetaches: 0, spinners: 0 };

/** The strip of the cell that holds `paneId` - NOT the window strip above it. */
function stripOf(page: Page, paneId: string) {
  return page
    .locator(`[role="main"] [data-split-card]:has([data-testid="panel-tab-bar"] [data-pane-id="${paneId}"])`)
    .first()
    .locator('[data-testid="panel-tab-bar"]')
    .first();
}

/** The tab ids of that strip, in visual order. */
async function tabOrder(page: Page, paneId: string): Promise<string[]> {
  return stripOf(page, paneId).evaluate((bar) =>
    Array.from(bar.querySelectorAll("[data-pane-id]")).map((t) => t.getAttribute("data-pane-id") || ""),
  );
}

/** The DOM order of the mounted pane shells - what the reload depends on. */
async function shellOrder(page: Page): Promise<string[]> {
  return page.locator("[data-pane-shell]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-pane-shell") || ""),
  );
}

/** The tab ids of every cell, in order - used to wait for the merge to land. */
function cells(page: Page): Promise<string[][]> {
  return page.locator('[role="main"] [data-split-card]').evaluateAll((cards) =>
    cards.map((c) =>
      Array.from(c.querySelectorAll('[data-testid="panel-tab-bar"] [data-pane-id]')).map(
        (t) => t.getAttribute("data-pane-id") || "",
      ),
    ),
  );
}

/** Drops the pane body of `source` onto the middle of the cell holding `target`: they become one group of two tabs. */
async function mergeIntoOneGroup(page: Page, source: string, target: string): Promise<void> {
  const src = page.locator(`[role="main"] [data-pane-id="${source}"]`).first();
  const s = await src.boundingBox();
  const all = await cells(page);
  const idx = all.findIndex((c) => c.includes(target));
  if (idx < 0) throw new Error(`no cell holds ${target}`);
  const b = await page.locator('[role="main"] [data-split-card]').nth(idx).boundingBox();
  if (!s || !b) throw new Error("cell without a bounding box");
  const x = b.x + b.width / 2;
  const y = b.y + b.height * 0.55;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2 + 8, { steps: 4 });
  await page.mouse.move(x, y, { steps: 14 });
  await page.mouse.move(x, y + 1, { steps: 2 });
  await page.mouse.up();
}


/** Opens a browser pane on each topic: two cells side by side, two live iframes. */
async function openTwoBrowserPanes(page: Page): Promise<void> {
  for (const id of [t1, t2]) {
    await page.evaluate(({ tid, url }) => {
      window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url } }));
    }, { tid: id, url: URL_PANE });
    await expect(page.locator(`[role="main"] [data-pane-id="browser:${id}"]`).first())
      .toBeVisible({ timeout: 15000 });
  }
  await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(2, { timeout: 15000 });
}

/**
 * The iframes must be SETTLED before the probe is armed: a load still in flight
 * would be counted as a reload, and the measurement would be a race instead of
 * a reading.
 */
async function settleBrowserFrames(page: Page): Promise<void> {
  await expect.poll(async () => page.locator('[data-testid="browser-iframe"]').evaluateAll(
    (frames) => frames.every((f) => (f as HTMLIFrameElement).contentDocument?.readyState === "complete"),
  ), { timeout: 10000 }).toBe(true);
}

/**
 * A caption burnt into the delivery clip - only under E2E_EVIDENCE, so the
 * suite pays nothing. A task preview is read at 268px: a big line of text is
 * the only thing that survives that width.
 */
async function caption(page: Page, text: string): Promise<void> {
  if (process.env.E2E_EVIDENCE !== "1") return;
  await page.evaluate((t) => {
    let el = document.getElementById("__e2e_caption__");
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_caption__";
      el.setAttribute(
        "style",
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
        "background:rgba(10,10,12,.92);color:#fff;font:700 40px/1.25 system-ui,sans-serif;" +
        "padding:14px 20px;letter-spacing:-.01em;border-top:3px solid #8b5cf6;",
      );
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

/** Real mouse drag: in Chromium HTML5 DnD starts from the mouse, not from a synthetic DragEvent. */
async function dragTab(page: Page, sourcePaneId: string, targetPaneId: string, side: "left" | "right"): Promise<void> {
  const strip = stripOf(page, sourcePaneId);
  const src = strip.locator(`[data-pane-id="${sourcePaneId}"]`).first();
  const target = strip.locator(`[data-pane-id="${targetPaneId}"]`).first();
  const s = await src.boundingBox();
  const d = await target.boundingBox();
  if (!s || !d) throw new Error("tab without a bounding box");
  const x = side === "left" ? d.x + d.width * 0.2 : d.x + d.width * 0.8;
  const y = d.y + d.height / 2;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2, { steps: 4 });
  await page.mouse.move(x, y, { steps: 14 });
  await page.mouse.move(x, y + 1, { steps: 2 });
  await page.mouse.up();
}

test.describe("Repositioning a tab keeps the pane alive", () => {
  test.use({ viewport: { width: 1440, height: 760 } });

  test.beforeAll(async ({ request }) => {
    t1 = (await createTopic(request, `E2E-REORD1-${Date.now()}`)).id;
    t2 = (await createTopic(request, `E2E-REORD2-${Date.now()}`)).id;
  });

  test.afterAll(async ({ request }) => {
    await closeAllBrowserContexts(request);
    for (const id of [t1, t2]) if (id) await deleteTopic(request, id).catch(() => {});
  });

  test.beforeEach(async ({ page, request, browserProcessPageV2 }) => {
    await resetPaneStore(request, [t1, t2]);
    // Browser panes without a real Chromium: `framable` makes them render as a
    // true <iframe>, which is the surface that reloads when it is moved.
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 5 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: URL_PANE, title: "Page", hasScreenshot: true,
    });
    await page.route(/\/api\/browsers\/framable/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: true }) }),
    );
  });

  test("REORD-01: dragging a tab to another position reloads nothing", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await goToApp(page);
    await expect(page.locator(`[data-pane-id="${t1}"]`).first()).toBeVisible({ timeout: 15000 });

    await openTwoBrowserPanes(page);

    // One cell, two tabs: the strip a reposition happens in.
    await mergeIntoOneGroup(page, `browser:${t1}`, `browser:${t2}`);
    await expect
      .poll(async () => (await cells(page)).find((c) => c.includes(`browser:${t2}`)) ?? [], { timeout: 8000 })
      .toEqual([`browser:${t2}`, `browser:${t1}`]);

    const before = await tabOrder(page, `browser:${t1}`);
    expect(before, "the merged strip must hold both browser tabs").toEqual([`browser:${t2}`, `browser:${t1}`]);
    const shellsBefore = await shellOrder(page);

    await settleBrowserFrames(page);
    await armProbe(page);
    await caption(page, "Two browser panes, one strip: the second tab moves first");
    // Move the LAST tab of the strip before the first one.
    await dragTab(page, `browser:${t1}`, `browser:${t2}`, "left");
    await expect.poll(() => tabOrder(page, `browser:${t1}`), { timeout: 8000 })
      .toEqual([`browser:${t1}`, `browser:${t2}`]);

    await caption(page, "Tabs swapped, pages untouched: no reload, no loader");
    const probe = await readProbe(page);
    const shellsAfter = await shellOrder(page);
    // One object, one diff: every counter is reported even when the first one is
    // already red, so the failure names the whole damage instead of its head.
    // The shell order is compared on the shells that existed BEFORE the gesture:
    // a pane mounting for its own reasons is not a reposition defect.
    const known = new Set(shellsBefore);
    expect({
      moved: forPane(probe, `browser:${t1}`),
      stayed: forPane(probe, `browser:${t2}`),
      shellOrder: shellsAfter.filter((k) => known.has(k)),
    }).toEqual({
      moved: UNDISTURBED,
      stayed: UNDISTURBED,
      shellOrder: shellsBefore,
    });
  });

  test("REORD-02: moving a tab to another group leaves the panes that stayed alone", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await goToApp(page);
    await expect(page.locator(`[data-pane-id="${t1}"]`).first()).toBeVisible({ timeout: 15000 });
    await openTwoBrowserPanes(page);
    await mergeIntoOneGroup(page, `browser:${t1}`, `browser:${t2}`);
    await expect
      .poll(async () => (await cells(page)).find((c) => c.includes(`browser:${t2}`)) ?? [], { timeout: 8000 })
      .toEqual([`browser:${t2}`, `browser:${t1}`]);

    await settleBrowserFrames(page);
    await armProbe(page);

    // The tab leaves its group for the window strip above: a cross-group move,
    // the other half of "repositioning a tab". The pane that changes group is
    // rebuilt - React has no way to re-parent a live subtree - but that is its
    // own business: the panes that did not move must not notice anything.
    const src = stripOf(page, `browser:${t1}`).locator(`[data-pane-id="browser:${t1}"]`).first();
    const target = page.locator('[role="main"] [data-testid="panel-tab-bar"]').first()
      .locator(`[data-pane-id="${t1}"]`).first();
    const s = await src.boundingBox();
    const d = await target.boundingBox();
    if (!s || !d) throw new Error("tab without a bounding box");
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2, { steps: 4 });
    await page.mouse.move(d.x + d.width * 0.8, d.y + d.height / 2, { steps: 14 });
    await page.mouse.move(d.x + d.width * 0.8, d.y + d.height / 2 + 1, { steps: 2 });
    await page.mouse.up();

    await expect
      .poll(async () => (await cells(page)).find((c) => c.includes(`browser:${t2}`)) ?? [], { timeout: 8000 })
      .toEqual([`browser:${t2}`]);

    const probe = await readProbe(page);
    expect({
      browserThatStayed: forPane(probe, `browser:${t2}`),
      chatThatStayed: forPane(probe, t2),
    }).toEqual({ browserThatStayed: UNDISTURBED, chatThatStayed: UNDISTURBED });
  });

  test("REORD-03: the BROWSER pane that changed group keeps its page", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // The half REORD-02 deliberately leaves out. There the moved pane is allowed
    // to be rebuilt ("React has no way to re-parent a live subtree") and only the
    // bystanders are asserted on; here the moved pane IS the subject, because for
    // an iframe a rebuild is not a remount, it is the page loading again and the
    // user's scroll, form and session going with it.
    //
    // Browser panes ONLY, and the scope is a decision, not an omission: a
    // terminal reconnects to a PTY that lives in another process and loses
    // nothing, an editor costs almost nothing. Widening this to every pane type
    // would be the scope escaping.
    await goToApp(page);
    await expect(page.locator(`[data-pane-id="${t1}"]`).first()).toBeVisible({ timeout: 15000 });
    await openTwoBrowserPanes(page);
    await mergeIntoOneGroup(page, `browser:${t1}`, `browser:${t2}`);
    await expect
      .poll(async () => (await cells(page)).find((c) => c.includes(`browser:${t2}`)) ?? [], { timeout: 8000 })
      .toEqual([`browser:${t2}`, `browser:${t1}`]);

    await settleBrowserFrames(page);
    await armProbe(page);
    await caption(page, "The browser tab leaves its group for the strip above");

    const src = stripOf(page, `browser:${t1}`).locator(`[data-pane-id="browser:${t1}"]`).first();
    const target = page.locator('[role="main"] [data-testid="panel-tab-bar"]').first()
      .locator(`[data-pane-id="${t1}"]`).first();
    const s = await src.boundingBox();
    const d = await target.boundingBox();
    if (!s || !d) throw new Error("tab without a bounding box");
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2, { steps: 4 });
    await page.mouse.move(d.x + d.width * 0.8, d.y + d.height / 2, { steps: 14 });
    await page.mouse.move(d.x + d.width * 0.8, d.y + d.height / 2 + 1, { steps: 2 });
    await page.mouse.up();

    await expect
      .poll(async () => (await cells(page)).find((c) => c.includes(`browser:${t2}`)) ?? [], { timeout: 8000 })
      .toEqual([`browser:${t2}`]);

    await caption(page, "Same page, same document: the group changed, the pane did not reload");
    const probe = await readProbe(page);
    // `iframes` is the count in the whole document, not a delta: a rebuild leaves
    // exactly one iframe behind too, but it is a DIFFERENT element. The counters
    // are what tell the two apart, and the count is here because the card states
    // the bar as "one iframe" and a reader should not have to infer it.
    const iframes = await page.locator('[data-testid="browser-iframe"]').count();
    const moved = forPane(probe, `browser:${t1}`);
    // THE SHELL STILL DETACHES, AND THAT IS THE SHAPE OF THE ANSWER, not a
    // shortfall hidden in a number. The pane really does move from one group's
    // React tree to another, and nothing short of hosting EVERY pane outside the
    // layout would stop that - which is the option card 0624e184 weighed and
    // rejected, in favour of "only the browser". What option 2 owes is that the
    // move costs the page nothing, and those are the three zeros below: the
    // document is not reloaded, the frame is not rebuilt, no loader is painted.
    //
    // Pinned at exactly 1 rather than waved through: 2 would mean the pane is
    // being remounted twice, and 0 would mean the whole-pane host landed after
    // all and this test should be read again.
    expect({
      pageKept: { iframeLoads: moved.iframeLoads, iframeMounts: moved.iframeMounts, spinners: moved.spinners },
      shellDetaches: moved.shellDetaches,
      iframes,
    }).toEqual({
      pageKept: { iframeLoads: 0, iframeMounts: 0, spinners: 0 },
      shellDetaches: 1,
      iframes: 2,
    });
  });
});
