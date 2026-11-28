import { readFileSync } from "fs";
import { execSync } from "child_process";
import { expect, test, type Page } from "@playwright/test";
import { createTopic, createTerminalSession, deleteTerminalSession, deleteTopic, seedPaneStore } from "./helpers/api-fixtures";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { judgeGrowth, type FootprintPoint } from "../../scripts/footprint-growth";

// Hermetic boundary: this spec restarts from the globalSetup baseline.
hermetic(test);

test.skip(({ browserName }) => browserName !== "webkit", "RSS of the real WPEWebProcess only exists under the webkit project.");

/**
 * THE OS-LEVEL RSS BAR FOR EACH CANDIDATE CHURN LOOP.
 *
 * WHY. `renderer-heap-growth.spec.ts` weighs the V8 heap over CDP, which is
 * Chromium-only and misses everything the JS heap does not own (layer
 * backings, native caches). This spec instead reads the RESIDENT SET of the
 * real `WPEWebProcess` the `webkit` Playwright project launches (this engine's
 * WPE backend, not WebKitGTK as the `webkit-2272` cache folder name suggests -
 * confirmed by inspecting the actual process tree Playwright spawns) - the
 * same process family `footprint -p` reads on macOS (`com.apple.WebKit.WebContent`
 * is Apple's name for this engine's web process). It is a weaker
 * proxy than `footprint` (RSS counts pages the kernel could still reclaim,
 * `footprint` does not) but it is the only OS-level number this engine exposes
 * without a Mac, and it is read from `/proc`, never `ps rss` misread as a
 * substitute for footprint on a system that HAS footprint.
 *
 * THE CANDIDATES. The card names four classes of suspect: "pane vive, tab
 * browser, store, liste non virtualizzate". Of those, only two produce a
 * client-side loop reachable without a native WKWebView (the browser-pane and
 * project-switch panes render their real content only under Tauri's
 * `useTauriBrowser`/`useTauriProjectWindow`, which need `window.__TAURI_INTERNALS__`
 * and are therefore inert here — see `pane-residency-cap.spec.ts`'s own
 * docstring on exactly this): open/close topics (the churn
 * `pane-residency-cap.spec.ts` already caps), terminal tabs, and scrolling a
 * long chat's virtualized list.
 *
 * READING A RED. A lap-over-lap climb that does not plateau once the
 * residency cap is reached says that loop's client bookkeeping leaks. A flat
 * series is not proof of ABSENCE in the two inert loops above — it proves
 * nothing ran there in this engine, which is why the delivery that reads this
 * file states that gap explicitly rather than claiming full coverage.
 *
 * @covers LEAK-03
 */

const BASE = E2E_BASE;
const LAPS = 10;
const REPS_PER_LAP = 6;
/** Long enough for WebKit's own idle GC pass to run before the sample, so a
 *  reading is the process at rest, not mid-allocation. */
const SETTLE_MS = 3000;

/** The limit the fixed `pane-store-v2` leak (persistLocal.ts) was measured
 *  against: FLAT at 2.05 MB/min after the cure, GROWS at 6.7-8.6 MB/min
 *  before it, across repeated runs. */
const MAX_MB_PER_MIN_TOPICS = 3;
/**
 * Terminal-session churn swings +-80 MB a lap with no sustained trend across
 * three independent runs (FLAT at -6.75, FLAT at -4.57, and one read of 3.06
 * - noise straddling a tight limit, not a leak): PTY session teardown on this
 * machine is itself noisy. A wider limit than the topics loop's on purpose.
 */
const MAX_MB_PER_MIN_TERMINAL = 15;
const MAX_MB_PER_MIN_SCROLL = 3;

/** Sum of `VmRSS` (kB) across every live `WPEWebProcess`, converted to MB. */
function webProcessRSSMB(): number {
  let pids: string[];
  try {
    pids = execSync("pgrep -f WPEWebProcess", { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
  } catch {
    return 0; // pgrep exits 1 with no matches
  }
  let kb = 0;
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf-8");
      const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      if (m) kb += Number(m[1]);
    } catch {
      // process exited between pgrep and the read: skip it, not a failure
    }
  }
  return kb / 1024;
}

async function sampleAfterSettle(): Promise<number> {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return webProcessRSSMB();
}

function report(name: string, series: FootprintPoint[], maxMBPerMin: number) {
  const verdict = judgeGrowth(series, maxMBPerMin);
  console.log(
    `[renderer-rss-growth] ${name}: ` + series.map((p) => p.mb.toFixed(1)).join(" -> ") + ` MB`,
  );
  console.log(`[renderer-rss-growth] ${name}: ${verdict.reason}`);
  return verdict;
}

test.describe("Renderer RSS growth per candidate loop", () => {
  test.describe.configure({ timeout: 600_000 });

  test("LEAK-03: open/close topics, terminal tabs and chat scroll, weighed in real process RSS", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LEAK-03" });

    // --- Loop A: open/close topics -----------------------------------
    // Seed BEFORE the first navigation: the client hydrates panes from the
    // pane-store snapshot on load, the same order `renderer-heap-growth.spec.ts`
    // relies on via its `beforeEach` hook (which runs before the test body).
    const stamp = Date.now();
    const topics: { id: string; name: string }[] = [];
    for (let i = 0; i < 16; i++) topics.push(await createTopic(request, `RssGrowth-${stamp}-${i}`));
    await seedPaneStore(request, () => ({
      panes: Object.fromEntries(topics.map((t) => [t.id, { id: t.id, type: "chat", title: t.name, topicId: t.id }])),
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
      .put(`${BASE}/api/ui-state/panels`, { data: { openPanels: topics.map((t) => t.id) }, ignoreHTTPSErrors: true })
      .catch(() => {});
    await goToApp(page);
    await expect(page.locator("[data-pane-shell]").first()).toBeAttached({ timeout: 15000 });

    const topicsSeries: FootprintPoint[] = [];
    for (let lap = 0; lap < LAPS; lap++) {
      for (const t of topics) {
        await page.getByTestId(`pane-tab-${t.id}`).click({ timeout: 10000 });
        await expect(page.locator(`[data-pane-shell="${t.id}"][data-pane-visible="1"]`)).toBeAttached({ timeout: 10000 });
      }
      topicsSeries.push({ t: lap * 60_000, mb: await sampleAfterSettle() });
    }
    const topicsVerdict = report("open/close topics", topicsSeries, MAX_MB_PER_MIN_TOPICS);
    for (const t of topics) await deleteTopic(request, t.id).catch(() => {});

    // --- Loop B: terminal tabs ----------------------------------------
    // One reload per lap, all REPS_PER_LAP sessions seeded together as tabs of
    // the SAME group (mirrors loop A's shape): a lone-pane group reloaded
    // one at a time never reached `data-pane-shell` in this engine, which this
    // loop sidesteps rather than chases, since the growth question does not
    // depend on how the tabs were opened.
    const terminalSeries: FootprintPoint[] = [];
    for (let lap = 0; lap < LAPS; lap++) {
      const sessions: string[] = [];
      for (let i = 0; i < REPS_PER_LAP; i++) sessions.push((await createTerminalSession(request, { cwd: "/tmp" })).id);
      const paneIds = sessions.map((id) => `terminal:${id}`);
      await seedPaneStore(request, () => ({
        panes: Object.fromEntries(
          sessions.map((id) => [`terminal:${id}`, { id: `terminal:${id}`, type: "terminal", title: "Terminal", terminalSessionId: id }]),
        ),
        groups: {
          "group:default": { id: "group:default", paneIds, splitRatio: 1, splitAxis: "horizontal" },
        },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
      }));
      await page.reload();
      for (const paneId of paneIds) {
        await page.getByTestId(`pane-tab-${paneId}`).click({ timeout: 10000 });
        await expect(page.locator(`[data-pane-shell="${paneId}"][data-pane-visible="1"]`)).toBeAttached({
          timeout: 10000,
        });
      }
      for (const id of sessions) await deleteTerminalSession(request, id);
      terminalSeries.push({ t: lap * 60_000, mb: await sampleAfterSettle() });
    }
    const terminalVerdict = report("terminal tabs open/close", terminalSeries, MAX_MB_PER_MIN_TERMINAL);

    // --- Loop C: scroll a long chat ------------------------------------
    // A lone pane in the group never reached `data-pane-shell` on reload in
    // this engine (same gap loop B hit first); a companion tab plus the same
    // click-and-check used in loop A sidesteps it.
    const longChat = await createTopic(request, `RssGrowth-long-${stamp}`);
    const companion = await createTopic(request, `RssGrowth-companion-${stamp}`);
    for (let i = 0; i < 200; i++) {
      await request
        .post(`${BASE}/api/topics/${longChat.id}/system-message`, {
          data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
          ignoreHTTPSErrors: true,
        })
        .catch(() => {});
    }
    await seedPaneStore(request, () => ({
      panes: {
        [longChat.id]: { id: longChat.id, type: "chat", title: longChat.name, topicId: longChat.id },
        [companion.id]: { id: companion.id, type: "chat", title: companion.name, topicId: companion.id },
      },
      groups: {
        "group:default": {
          id: "group:default",
          paneIds: [longChat.id, companion.id],
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
        data: { openPanels: [longChat.id, companion.id] },
        ignoreHTTPSErrors: true,
      })
      .catch(() => {});
    await page.reload();
    await page.getByTestId(`pane-tab-${longChat.id}`).click({ timeout: 10000 });
    await expect(page.locator(`[data-pane-shell="${longChat.id}"][data-pane-visible="1"]`)).toBeAttached({
      timeout: 15000,
    });
    const scroller = page
      .locator('[data-pane-shell][data-pane-visible="1"] [data-testid="chat-scroll-container"]')
      .first();

    const scrollSeries: FootprintPoint[] = [];
    for (let lap = 0; lap < LAPS; lap++) {
      for (let i = 0; i < REPS_PER_LAP; i++) {
        await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await expect
          .poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
          .toBeLessThanOrEqual(1);
        await scroller.evaluate((el) => (el.scrollTop = 0));
        await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
      }
      scrollSeries.push({ t: lap * 60_000, mb: await sampleAfterSettle() });
    }
    const scrollVerdict = report("chat scroll", scrollSeries, MAX_MB_PER_MIN_SCROLL);
    await deleteTopic(request, longChat.id).catch(() => {});
    await deleteTopic(request, companion.id).catch(() => {});

    for (const verdict of [topicsVerdict, terminalVerdict, scrollVerdict]) {
      expect(verdict.ok, verdict.reason).toBe(true);
    }
  });
});
