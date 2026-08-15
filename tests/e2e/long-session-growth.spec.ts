import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/**
 * long-session-growth.spec.ts - THE BENCH for what a session accumulates.
 * It is not the gate: the gate is `scripts/check-session-growth.ts`.
 *
 * WHY. The goal asks for no meaningful progressive heap, DOM node, listener or
 * process growth during long sessions, and this app is a long session by
 * construction: it is left open for days, panes are opened and closed, topics
 * are switched, messages stream in. Every gate in this repo measures a single
 * moment instead: bundle bytes at build time, latency of one gesture, frames of
 * one scroll. A leak is invisible to all of them by definition, because a leak
 * is a DERIVATIVE and they all take one sample.
 *
 * WHAT A CYCLE IS. Three interactions repeated N times, chosen because each one
 * mounts and unmounts something different:
 *
 *   switch topic     tab A, tab B, tab A. Panes stay resident under
 *                    `display:none`, so this exercises reveal and hide rather
 *                    than construction.
 *   close and reopen a pane   the real mount and unmount: a chat pane holds a
 *                    WebSocket subscription, observers, virtualiser state. If
 *                    anything survives its own panel, it survives here.
 *   stream a burst   messages posted server side and delivered over the live
 *                    WebSocket, which is the fan-out path plus the transcript
 *                    append.
 *
 * WHY A RATIO AND NOT A NUMBER. An absolute megabyte figure is a fact about the
 * machine that took it, and would have to be refitted on every laptop and every
 * CI runner. Cycle 50 divided by cycle 5 is a fact about the CODE: it says the
 * app stopped growing after warm-up, whatever the absolute values are. Cycle 5
 * and not cycle 1 because the first cycles are warm-up: lazy chunks, the first
 * paint of every pane type, caches filling. Measuring against cycle 1 would call
 * that growth a leak.
 *
 * WHY GC BEFORE EVERY SAMPLE. Without a forced collection the heap reading is
 * whatever V8 has not bothered to reclaim, which moves by tens of megabytes
 * between two identical states. `HeapProfiler.collectGarbage` makes the number
 * mean "retained", which is the only thing a leak test can talk about.
 *
 * WHAT IS KNOWN TO GROW ON PURPOSE, so nobody reads it as a defect: the
 * transcript keeps the messages this bench streams into it (2 per cycle), and
 * that is retained state the app is supposed to hold. It is bounded and small
 * next to the app's own footprint, the DOM does not grow with it because the
 * transcript is virtualised, and the number of messages is written into the JSON
 * so the reader can size it.
 *
 * THIS FILE ASSERTS NO THRESHOLD. It fails only when the BENCH did not work:
 * cycles that did not run, a pane that never came back, a heap reading of zero.
 * The budget lives in `scripts/session-growth-baseline.json` and is applied by
 * `scripts/check-session-growth.ts`.
 *
 * HOW TO SEE IT GO RED. `TOPICS_GROWTH_LEAK_NODES=120` appends 120 retained
 * nodes, listeners and payloads per cycle: a real leak of exactly the shape this
 * bench claims to catch, growing all three metrics at once.
 */

const BASE = E2E_BASE;

/** Cycles per run. The ratio is cycle SAMPLE_FLOOR against this one. */
const CYCLES = Number(process.env.TOPICS_GROWTH_CYCLES || 50);
/** The warm-up boundary: the first sample the ratio is taken from. */
const SAMPLE_FLOOR = 5;
/** Messages posted into the open chat per cycle. */
const BURST = 2;
/** Retained nodes appended per cycle by the falsification lever. Zero = nothing injected. */
const LEAK_NODES = Number(process.env.TOPICS_GROWTH_LEAK_NODES || 0);

const OUT_PATH = resolve(
  process.env.TOPICS_GROWTH_OUT?.trim() || "test-results/session-growth-measure.json",
);

interface Sample {
  cycle: number;
  heap_bytes: number;
  dom_nodes: number;
  listeners: number;
  /**
   * The renderer's own node count. It sees nodes that are DETACHED but still
   * referenced by JavaScript, which `getElementsByTagName` cannot: reported so a
   * detached-subtree leak is visible in the artefact even though the judged
   * ratio uses the attached count.
   */
  retained_nodes: number;
  documents: number;
}

interface CdpMetrics {
  metrics: Array<{ name: string; value: number }>;
}

type LeakWindow = Window & { __topicsGrowthLeak?: Array<{ node: Element; payload: string }> };

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * One sample, after a forced collection.
 *
 * Heap and listeners come from CDP because there is no other honest source:
 * `performance.memory` is coarse and gated, and counting listeners from the page
 * is impossible once a library attaches them. DOM nodes are counted in the page
 * on purpose, so the headline number is the one anybody can reproduce in a
 * console.
 */
async function takeSample(page: Page, cdp: CDPSession, cycle: number): Promise<Sample> {
  await cdp.send("HeapProfiler.collectGarbage");
  const raw = (await cdp.send("Performance.getMetrics")) as unknown as CdpMetrics;
  const byName = new Map(raw.metrics.map((m) => [m.name, m.value]));
  const dom_nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  return {
    cycle,
    heap_bytes: byName.get("JSHeapUsedSize") ?? 0,
    dom_nodes,
    listeners: byName.get("JSEventListeners") ?? 0,
    retained_nodes: byName.get("Nodes") ?? 0,
    documents: byName.get("Documents") ?? 0,
  };
}

/**
 * The injected leak: retained nodes, retained listeners, retained bytes.
 *
 * Every piece is held by a global array, so a forced collection cannot reclaim
 * it, and the payload carries the running index so V8 cannot dedupe identical
 * strings and quietly flatten the heap growth this is meant to produce.
 */
async function injectLeak(page: Page, count: number): Promise<void> {
  if (count <= 0) return;
  await page.evaluate((n: number) => {
    const w = window as LeakWindow;
    if (!w.__topicsGrowthLeak) w.__topicsGrowthLeak = [];
    let host = document.getElementById("topics-growth-leak");
    if (!host) {
      host = document.createElement("div");
      host.id = "topics-growth-leak";
      host.style.display = "none";
      document.body.appendChild(host);
    }
    for (let i = 0; i < n; i++) {
      const node = document.createElement("span");
      const payload = `leak-${w.__topicsGrowthLeak.length}-`.repeat(64);
      node.textContent = "x";
      node.addEventListener("click", () => {
        void payload.length;
      });
      host.appendChild(node);
      w.__topicsGrowthLeak.push({ node, payload });
    }
  }, count);
}

test.describe("@nightly Long session - heap, DOM and listener growth", () => {
  // Fifty cycles, each closing a pane through its 3 s soft confirm: this bench
  // is measured in minutes by design. It is a long-session test.
  test.describe.configure({ timeout: 1_500_000 });

  const stamp = Date.now();
  let topicA: { id: string; name: string };
  let topicB: { id: string; name: string };
  const seededA = `growth-seed-A-${stamp}`;
  const seededB = `growth-seed-B-${stamp}`;

  /** The chat session key of a topic: `topic:` plus the first 8 chars of its id. */
  const sessionKeyOf = (id: string): string => `topic:${id.slice(0, 8)}`;

  test.beforeAll(async ({ request }) => {
    topicA = await createTopic(request, `E2E-Growth-A-${stamp}`);
    topicB = await createTopic(request, `E2E-Growth-B-${stamp}`);
    // Both chats start with content: an empty transcript takes a one-off mount
    // cost the first time it stops being empty, and paying it inside cycle 1
    // would show up as growth that never repeats.
    await seedMessage(request, { sessionKey: sessionKeyOf(topicA.id), role: "user", content: seededA });
    await seedMessage(request, { sessionKey: sessionKeyOf(topicB.id), role: "user", content: seededB });
  });

  test.afterAll(async ({ request }) => {
    for (const t of [topicA, topicB]) if (t) await deleteTopic(request, t.id).catch(() => {});
  });

  // `@nightly` on the test title as well as the describe: the PR tier excludes
  // it with `grepInvert: /@nightly/`, which is where every other tagged test in
  // this suite carries it. Ten minutes of cycles do not belong on the
  // pull-request path; the gate script runs this on demand.
  test("does not grow across fifty cycles of the same interaction @nightly", async ({ page }, testInfo) => {
    await resetPaneStore(page.request, [topicA.id, topicB.id]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabOf = (id: string) => tabBar.locator(`[data-pane-id="${id}"]`);
    const panelOf = (name: string) => `[data-testid="chat-panel"][aria-label="${name} panel"]`;
    const contentOf = (name: string) => `${panelOf(name)} [data-message-id]`;

    const showPane = async (t: { id: string; name: string }, text: string): Promise<void> => {
      await tabOf(t.id).first().click();
      await expect(
        page.locator(contentOf(t.name), { hasText: text }).first(),
      ).toBeVisible({ timeout: 20_000 });
    };

    // Untimed warm-up over both chats: opening a chat for the FIRST time is a
    // different and much more expensive thing than switching between two open
    // ones, and it must not land inside cycle 1.
    await showPane(topicA, seededA);
    await showPane(topicB, seededB);
    await showPane(topicA, seededA);

    let panesReopened = 0;
    let messagesStreamed = 0;

    /**
     * Close pane B and bring it back.
     *
     * Reopened from the command palette and NOT from the sidebar, and the reason
     * is a real trap: closing a standalone chat archives its topic, and the
     * unified sidebar hard-skips archived standalone chats. The row is simply
     * gone, so a sidebar click would fail on cycle 1 for a reason that has
     * nothing to do with leaks. The recently-closed list is the surface that
     * still knows about it.
     */
    const closeAndReopenB = async (): Promise<void> => {
      const tab = tabOf(topicB.id).first();
      await tab.hover();
      // `force`: this click is not verifying reachability, it is operating a
      // control the hover just revealed. The close is a 3 s soft confirm, so the
      // wait below is generous on purpose.
      await tab.locator("button").last().click({ force: true });
      await expect(tabOf(topicB.id)).toHaveCount(0, { timeout: 15_000 });

      await page.keyboard.press("Meta+k");
      const palette = page.locator('[data-testid="command-palette"]');
      await expect(palette).toBeVisible({ timeout: 10_000 });
      await palette.getByRole("option").filter({ hasText: topicB.name }).first().click();
      // The palette must be GONE before the cycle moves on: it is an overlay, and
      // the next action in the loop is a click on a tab underneath it.
      await expect(palette).toBeHidden({ timeout: 10_000 });
      await expect(tabOf(topicB.id)).toHaveCount(1, { timeout: 15_000 });
      panesReopened++;
    };

    const streamBurst = async (cycle: number): Promise<void> => {
      let last = "";
      for (let k = 0; k < BURST; k++) {
        last = `growth-c${cycle}-${k}-${stamp}`;
        const res = await page.request.post(`${BASE}/api/topics/${topicA.id}/system-message`, {
          data: { content: last },
        });
        expect(res.ok(), "the server refused to stream a message").toBe(true);
        messagesStreamed++;
      }
      // The LAST message painted is the proof the burst arrived over the live
      // socket. Waiting on the count instead would pass on a transcript that
      // never repainted.
      await expect(
        page.locator(contentOf(topicA.name), { hasText: last }).first(),
      ).toBeVisible({ timeout: 30_000 });
    };

    const samples: Sample[] = [];
    const sampleAt = new Set<number>([SAMPLE_FLOOR, 10, 20, 30, 40, CYCLES]);
    let cyclesCompleted = 0;

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      await showPane(topicB, seededB);
      await showPane(topicA, seededA);
      await closeAndReopenB();
      await showPane(topicA, seededA);
      await streamBurst(cycle);
      await injectLeak(page, LEAK_NODES);
      cyclesCompleted++;
      if (sampleAt.has(cycle)) samples.push(await takeSample(page, cdp, cycle));
    }

    const first = samples.find((s) => s.cycle === SAMPLE_FLOOR);
    const last = samples[samples.length - 1];
    expect(first, `no sample was taken at cycle ${SAMPLE_FLOOR}`).toBeDefined();
    expect(last, "no final sample was taken").toBeDefined();
    // The three ways this bench can stop measuring while staying green. A zero
    // heap means CDP answered with nothing, and a ratio over zero is infinity.
    expect(first!.heap_bytes, "the heap reading is zero: CDP measured nothing").toBeGreaterThan(0);
    expect(first!.dom_nodes, "the page has no DOM: nothing was loaded").toBeGreaterThan(100);
    expect(cyclesCompleted, "no cycle completed").toBe(CYCLES);

    const ratio = (pick: (s: Sample) => number): number => round(pick(last!) / pick(first!));

    const measure = {
      $schema: "session-growth-v1",
      surface: "chat panes, tab switching and streamed messages",
      measured_at: new Date().toISOString(),
      leak_injected_nodes: LEAK_NODES,
      protocol: {
        cycles: CYCLES,
        baseline_cycle: SAMPLE_FLOOR,
        final_cycle: last!.cycle,
        burst_per_cycle: BURST,
        cycle: "switch to B, back to A, close B and reopen it from the palette, stream a burst into A",
        gc: "HeapProfiler.collectGarbage before every sample",
      },
      ratio: {
        heap: ratio((s) => s.heap_bytes),
        dom_nodes: ratio((s) => s.dom_nodes),
        listeners: ratio((s) => s.listeners),
        retained_nodes: ratio((s) => s.retained_nodes),
      },
      witness: {
        cycles_completed: cyclesCompleted,
        panes_reopened: panesReopened,
        messages_streamed: messagesStreamed,
        gc_forced: true,
        first: first!,
        last: last!,
      },
      samples,
    };

    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(measure, null, 2)}\n`);
    testInfo.annotations.push({
      type: "session-growth",
      description:
        `heap x${measure.ratio.heap}, dom x${measure.ratio.dom_nodes}, ` +
        `listeners x${measure.ratio.listeners} over ${CYCLES} cycles`,
    });
    console.log(
      `[growth] cycle ${SAMPLE_FLOOR} -> ${last!.cycle}: heap x${measure.ratio.heap}  ` +
        `dom x${measure.ratio.dom_nodes}  listeners x${measure.ratio.listeners} -> ${OUT_PATH}`,
    );
  });
});
