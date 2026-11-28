import { expect, test, type Page } from "@playwright/test";
import { createTopic, deleteTopic, seedPaneStore } from "./helpers/api-fixtures";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Hermetic boundary: this spec restarts from the globalSetup baseline.
hermetic(test);

/**
 * THE RENDERER GROWTH BAR (card "Perdita di memoria nel renderer WebContent di Topics") allow-italian: the card title, quoted verbatim
 * 2026-11-27: main WebContent at 2337 MB after 9h34m, measured
 * with `footprint -p` on macOS, not `ps rss`).
 *
 * WHAT THIS SPEC MEASURES, AND WHAT IT CANNOT MEASURE HERE. `footprint -p`
 * reads `phys_footprint` of the WKWebView process - a WebKit metric on macOS
 * that does not exist under Playwright/Chromium and does not exist on this
 * machine (Linux, no Tauri). The honest proxy available everywhere is the
 * same one `pane-residency-cap.spec.ts` already uses: a DOM census
 * (`domCensus()` in `lib/devHeapProbe.ts`, already in the repo and built for
 * exactly this - "who holds the heap, measured instead of guessed") plus the
 * weight every store declares (`collectHeapReport()`, the same inventory
 * behind the Performance panel). A DOM that does not come back flat after a
 * churn loop is the direct cause of a `footprint` that does not come back
 * flat: every promoted node carries a CoreAnimation layer with an IOSurface
 * backing, invisible to the JS heap and visible only to `footprint` - see
 * `domCensus`'s own comment.
 *
 * AND THE SAME LOOP IS WEIGHED IN BYTES. DOM nodes answer "who holds it",
 * they do not answer "how much". The byte reading available in a headless run
 * is the V8 heap after a forced collection, taken over CDP
 * (`HeapProfiler.collectGarbage` then `Runtime.getHeapUsage`): forcing the
 * collection first is what separates garbage not yet swept (noise) from
 * objects still reachable (the leak). It is a LOWER BOUND on the footprint the
 * card measured - it misses layer backings, decoded images and the WebKit-side
 * caches - so a growth it sees is real, while a flat heap does not by itself
 * clear `footprint`. That second question is what `bun run
 * check:renderer-growth` answers on the Mac, on the real app.
 *
 * THE GROWING LOOP: open, visit and close N topics repeatedly (the exact
 * suspect the card names - "pane vive, tab browser" - and the same walk
 * `pane-residency-cap.spec.ts` already runs, repeated several times instead
 * of once). One walk alone proves nothing: the residency cap leaves a
 * constant remainder (LIGHT_BUDGET+1 shells), and that remainder is not a
 * leak. It is the DELTA between one lap and the next, once the cap is
 * already reached, that must be zero.
 *
 * RED BEFORE, GREEN AFTER. Rolling `RESIDENCY_BUDGET` back to `Infinity`
 * (the pre-2026-07-29 behaviour, documented as the rollback in `policy.ts`:
 * "both to Infinity restores exactly the previous behaviour") would leave
 * EVERY shell from the previous lap mounted on top of the new one instead of
 * the cap's constant remainder, so the growth per lap would jump orders of
 * magnitude above `MAX_NODE_GROWTH_PER_LAP` and this spec would go red. With
 * the cap in place (the repo's current state) it stays green - not run here
 * (e2e does not run on this machine); the same `RESIDENCY_BUDGET` is the one
 * `pane-residency-cap.spec.ts` already exercises green.
 *
 * @covers LEAK-02
 */

const BASE = E2E_BASE;

/** How many topics per lap. Must exceed the cap (12 light + 1 visible) to
 *  bite the real question: a lap WITHIN the cap never exercises eviction. */
const TOPIC_COUNT = 16;
/** How many times the full lap repeats. Two are enough to isolate the growth
 *  PER LAP from the first lap's fixed cost (history never fetched yet, bundle
 *  just loaded, etc.) - the comparison that matters is lap 3 against lap 2,
 *  not the first against the last. */
const LAPS = 3;
/**
 * The residency budget for light panes, the same number
 * `pane-residency-cap.spec.ts` reads: the visible one plus the class budget.
 * A lap mounts every topic it visits, so right after a lap the mounted shells
 * are MORE than the cap and the eviction trims them once the dwell window
 * (MIN_DWELL_MS 4000 + EVICT_DELAY_MS 1500) elapses. Waiting for the count to
 * come back down is therefore the real condition this spec needs - the sample
 * is only comparable between laps once the cap holds again - and it replaces
 * the fixed sleep the convention forbids.
 */
const LIGHT_BUDGET = 12;
/** How long the eviction may take to land before the wait is a failure. */
const EVICTION_TIMEOUT_MS = 25000;

/**
 * Tolerance per node/DELTA between two laps once the cap is reached. Not an
 * exact zero: a lap also changes legitimate things (an unread badge, a
 * relative timestamp, a third lap tripping a long-period poll) - a handful of
 * nodes is noise, hundreds are a leak. The number is deliberately tight: the
 * invariant being protected is "AFTER the cap, one more lap leaves NOTHING
 * extra", not "it grows a little".
 */
const MAX_NODE_GROWTH_PER_LAP = 40;
const MAX_SVG_GROWTH_PER_LAP = 10;

/**
 * Tolerance in BYTES on the V8 heap between two steady-state laps, after a
 * forced collection. The card's leak is 2337 MB in 9h34m, around 4 MB a
 * minute, and one lap here is roughly a minute of churn: a limit of 6 MB per
 * lap therefore sits under the observed rate while leaving room for what a lap
 * legitimately allocates and keeps (one more entry per topic in the caches
 * that are capped by design, the strings of a freshly fetched history).
 */
const MAX_HEAP_GROWTH_PER_LAP_BYTES = 6 * 1024 * 1024;

interface HeapSnapshot {
  dom: { svg: number; nodes: number; perOwner: Record<string, number> };
  owners: Record<string, { entries: number; items?: number; bytes?: number }>;
}

interface Sample extends HeapSnapshot {
  /** V8 heap in use after a forced collection, in bytes. */
  heapBytes: number;
}

declare global {
  interface Window {
    __topicsHeapSnapshot?: () => HeapSnapshot;
  }
}

async function snapshot(page: Page): Promise<HeapSnapshot> {
  return page.evaluate(() => {
    const fn = window.__topicsHeapSnapshot;
    if (!fn) throw new Error("__topicsHeapSnapshot is not armed: initDevHeapProbe did not run");
    return fn();
  });
}

/**
 * Heap in use in bytes, garbage already collected. Three collections instead
 * of one: a single pass leaves objects whose only remaining reference was a
 * weak one dropped during that very pass, which reads as growth that is not
 * there.
 */
async function heapBytes(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.enable");
    for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
    const usage = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    return usage.usedSize;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function sample(page: Page): Promise<Sample> {
  return { ...(await snapshot(page)), heapBytes: await heapBytes(page) };
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

function shells(page: Page) {
  return page.locator("[data-pane-shell]");
}

/**
 * Waits for the churn of a lap to be over: the mounted shells back within the
 * cap, which is the state the two samples must share to be comparable.
 */
async function waitForEvictionToSettle(page: Page): Promise<void> {
  await expect
    .poll(() => shells(page).count(), {
      timeout: EVICTION_TIMEOUT_MS,
      message: `mounted shells must come back down to ${LIGHT_BUDGET + 1}`,
    })
    .toBeLessThanOrEqual(LIGHT_BUDGET + 1);
}

test.describe("Renderer growth bar", () => {
  test.describe.configure({ timeout: 180_000 });

  const topics: { id: string; name: string }[] = [];

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    for (let i = 0; i < TOPIC_COUNT; i++) {
      topics.push(await createTopic(request, `HeapGrowth-${stamp}-${i}`));
    }
  });

  test.afterAll(async ({ request }) => {
    for (const t of topics) await deleteTopic(request, t.id).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await seedPaneStore(request, () => ({
      panes: Object.fromEntries(
        topics.map((t) => [t.id, { id: t.id, type: "chat", title: t.name, topicId: t.id }]),
      ),
      groups: {
        "group:default": {
          id: "group:default",
          paneIds: topics.map((t) => t.id),
          splitRatio: 1,
          splitAxis: "horizontal",
        },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await request
      .put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: topics.map((t) => t.id) },
        ignoreHTTPSErrors: true,
      })
      .catch(() => {});
  });

  async function visitEveryTopic(page: Page): Promise<void> {
    for (const t of topics) {
      await page.getByTestId(`pane-tab-${t.id}`).click({ timeout: 10000 });
      await expect(page.locator(`[data-pane-shell="${t.id}"][data-pane-visible="1"]`)).toBeAttached({
        timeout: 10000,
      });
    }
  }

  test("LEAK-02: one more lap, once the cap is reached, leaves nothing extra", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LEAK-02" });
    await goToApp(page);
    await expect(shells(page).first()).toBeAttached({ timeout: 15000 });

    // First lap: brings residency to its steady state (cap reached, chat
    // history fetched). Its cost is not what is under test.
    await visitEveryTopic(page);
    await waitForEvictionToSettle(page);

    const samples: Sample[] = [await sample(page)];
    for (let lap = 1; lap < LAPS; lap++) {
      await visitEveryTopic(page);
      await waitForEvictionToSettle(page);
      samples.push(await sample(page));
    }

    // Compare ONLY steady-state laps: sample[0] is after the warm-up lap,
    // sample[1..] are the repeated laps against the same cap.
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      const nodeGrowth = cur.dom.nodes - prev.dom.nodes;
      const svgGrowth = cur.dom.svg - prev.dom.svg;
      const heapGrowth = cur.heapBytes - prev.heapBytes;
      console.log(
        `[renderer-heap-growth] lap ${i}: nodes ${prev.dom.nodes}->${cur.dom.nodes} (+${nodeGrowth}), ` +
          `svg ${prev.dom.svg}->${cur.dom.svg} (+${svgGrowth}), ` +
          `heap ${mb(prev.heapBytes)}->${mb(cur.heapBytes)} MB (+${mb(heapGrowth)} MB)\n` +
          `  owners: ${JSON.stringify(cur.owners)}`,
      );
      expect(nodeGrowth, `extra DOM nodes on lap ${i} (cap already reached)`).toBeLessThanOrEqual(
        MAX_NODE_GROWTH_PER_LAP,
      );
      expect(svgGrowth, `extra <svg> on lap ${i} (cap already reached)`).toBeLessThanOrEqual(
        MAX_SVG_GROWTH_PER_LAP,
      );
      expect(
        heapGrowth,
        `extra heap bytes on lap ${i} after a forced collection (cap already reached): ` +
          `+${mb(heapGrowth)} MB, limit ${mb(MAX_HEAP_GROWTH_PER_LAP_BYTES)} MB`,
      ).toBeLessThanOrEqual(MAX_HEAP_GROWTH_PER_LAP_BYTES);
    }
  });
});
