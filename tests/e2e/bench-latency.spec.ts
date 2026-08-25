/**
 * bench-latency.spec.ts — THE BENCH for the gestures a working day is made of.
 * It is not a gate: it measures, writes `test-results/bench-latency.json`, and
 * asserts only that the harness worked. The report is `scripts/bench/latency.ts`.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A SECOND INK BENCH. `ink-latency.spec.ts`
 * owns the three most frequent gestures INSIDE a running workspace (open a card,
 * switch tab, send a message). Nothing measures what a workspace costs before it
 * is running, nor what it costs as the board fills up. Those are the numbers a
 * competitor's table would publish about us, and they are the ones nobody here
 * had ever taken.
 *
 * WHAT IT MEASURES, and what each number is made of:
 *
 *   boot_first_frame    navigation start → the first contentful paint. Read from
 *                       `PerformancePaintTiming`, the browser's own entry, not a
 *                       wall clock around `page.goto` (that number contains the
 *                       driver's round trips, which are the harness, not the app).
 *   boot_interactive    navigation start → the frame that PRESENTS a usable
 *                       sidebar row. "Usable" is a row with `role="treeitem"`
 *                       painted and enabled, not the sidebar container: the
 *                       container is laid out long before there is anything in it
 *                       to click, so a container-shaped target would report the
 *                       app as interactive while it still shows an empty rail.
 *   topic_open_cold     click a chat tab whose pane has NEVER been revealed in
 *                       this document → its transcript is readable. Deliberately
 *                       excluded from the ink budget (see `ink-budget.json`), and
 *                       for a good reason: most of it is `LIST_REVEAL_FLOOR_MS`,
 *                       a curtain held on purpose. It is measured here as a
 *                       REPORTED number with its composition written next to it,
 *                       never as a threshold.
 *   board_paint_<n>     navigation start → the n-th task card is painted, with
 *                       the board as the active pane. n ∈ {50, 200, 500}, seeded
 *                       through the real task API.
 *
 * WHY BOARD PAINT IS MEASURED FROM NAVIGATION START and not from a tab click:
 * background panes stay mounted under `display:none` (StandaloneChatGroup), so
 * revealing an already-rendered board measures a style change, not the cost of
 * drawing n cards. From navigation start the number contains the fetch, the
 * React commit and the layout of all n cards, which is the thing that scales.
 *
 * WHY THE CARDS ARE SEEDED IN `todo`. `boardOrder.ts` pages only `review` and
 * `done` (COLUMN_PAGE = 25); the three working columns are drawn WHOLE, always,
 * because a card missing from dnd-kit's registry is a drop target that fails in
 * silence. So `todo` is where n cards really means n cards in the DOM.
 *
 * ONE PAGE PER SAMPLE, AND NOTHING INHERITED. Every sample opens its own page
 * and closes it, because `addInitScript` accumulates on a page and the probe has
 * to be configured per navigation. Each of those pages wipes localStorage at
 * document start, so no sample boots on the snapshot the previous one left
 * behind (`clearPersistedState`, and the note there for what that cost the first
 * run of this bench). The context is kept, so the HTTP cache stays warm; the
 * first load of the run is discarded as a warm-up, because these numbers
 * describe a desktop shell that has run before, which is the only state a
 * returning user is ever in.
 *
 * HOW TO SEE IT MEASURE THE DEFECT. `BENCH_LATENCY_STALL_MS=120` burns 120 ms
 * inside every animation frame of the first five seconds of the document, and
 * inside every `pointerdown`. That is the shape of a real boot regression (work
 * per frame while the app comes up), so every number here has to move. It is the
 * falsification lever `scripts/bench/latency.ts --stall` drives.
 *
 * @covers PERF-02
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { measureInk, median } from "./helpers/ink";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id, like `inkbench-e2e001`: the general board aggregates every board. */
const BOARD_ID = "benchlat-e2e001";

/** Samples for boot and cold open. Odd, so the median is a value that happened. */
const SAMPLES = Number(process.env.BENCH_LATENCY_SAMPLES ?? 5);
/** Samples per board volume. Odd for the same reason; three because a 500-card load is not cheap. */
const BOARD_SAMPLES = 3;
/**
 * The volumes. 50 is a live project, 500 is the board of somebody who never
 * archives. Overridable so the bench can be exercised quickly while it is being
 * changed; the published run uses the default.
 */
const BOARD_VOLUMES = (process.env.BENCH_LATENCY_VOLUMES ?? "50,200,500")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** Milliseconds burned per animation frame during boot, and per pointerdown. The falsification lever. */
const STALL_MS = Number(process.env.BENCH_LATENCY_STALL_MS ?? 0);
/** How long the stall keeps burning after the document starts. Long enough to cover a boot. */
const STALL_WINDOW_MS = 5_000;

const OUT_PATH = resolve(process.env.BENCH_LATENCY_OUT?.trim() || "test-results/bench-latency.json");

/** A sidebar row: the smallest thing whose presence means "the sidebar can be used". */
const SIDEBAR_ROW = '[aria-label="Topics sidebar"] [role="treeitem"]';
/** Task cards in the column that is never paged. */
const TODO_CARD = '[data-testid="kanban-column-body-todo"] [data-task-card]';

/** Ceiling for one probe before it reports "never painted" instead of hanging. */
const PROBE_TIMEOUT_MS = 40_000;

interface ProbeResult {
  /** Milliseconds from the document's time origin to the frame that presented the target. */
  ms: number | null;
  frames: number;
  error: string | null;
}

interface ProbeHandle {
  promise: Promise<ProbeResult>;
}

interface ProbeTarget {
  selector: string;
  minCount: number;
}

declare global {
  interface Window {
    __benchBoot?: ProbeHandle;
  }
}

interface Measured {
  label: string;
  metric: string;
  samples: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

const stamp = Date.now();
const topics: Array<{ id: string; name: string }> = [];
const seeded: string[] = [];
const taskIds: string[] = [];

test.describe("@nightly Latency bench — boot, cold topic open, board paint", () => {
  // Seeding 500 cards and loading the app 14 times does not fit the default timeout.
  test.describe.configure({ timeout: 900_000 });
  // 1600 wide: at 1280 the five board columns do not fit and `todo` ends up
  // behind a horizontal scroll, where its cards are laid out but off-screen.
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < SAMPLES; i++) {
      const topic = await createTopic(request, `E2E-Bench-Lat-${i}-${stamp}`);
      topics.push(topic);
      const text = `bench-lat-seed-${i}-${stamp}`;
      seeded.push(text);
      // `topic:<first 8 chars>` — the session key the server and the client agree
      // on. Seeding under the full uuid writes a session nobody reads.
      await seedMessage(request, {
        sessionKey: `topic:${topic.id.slice(0, 8)}`,
        role: "user",
        content: text,
      });
    }
  });

  test.afterAll(async ({ request }) => {
    for (let i = 0; i < taskIds.length; i += 25) {
      await Promise.all(
        taskIds.slice(i, i + 25).map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})),
      );
    }
    for (const topic of topics) await deleteTopic(request, topic.id).catch(() => {});
  });

  test("measures boot, cold topic open and board paint at 50/200/500 cards @nightly", async (
    { page, request },
    testInfo,
  ) => {
    const context = page.context();
    const gestures: Record<string, Measured> = {};
    const witness: Record<string, number | string> = {};

    // ------------------------------------------------------- warm the cache --
    // The very first load of the run pays for an empty HTTP cache, and no
    // returning user ever pays that twice. Discarded on purpose, and said out
    // loud in the JSON rather than averaged into the boot numbers.
    {
      await resetPaneStore(request, ["__board__", topics[0].id]);
      const warm = await context.newPage();
      await warm.goto("/");
      await warm.waitForSelector(SIDEBAR_ROW, { state: "visible", timeout: 30_000 });
      await warm.close();
    }

    // ------------------------------------------------- boot + cold topic open --
    const firstFrame: number[] = [];
    const interactive: number[] = [];
    const coldOpen: number[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      const topic = topics[i]!;
      // The board FIRST in the group: with no `activePaneId` in the seeded
      // snapshot the client falls back to the first pane, which is what keeps
      // this topic cold — a pane that is already active at load has been opened,
      // and its "first open" would measure nothing.
      await resetPaneStore(request, ["__board__", topic.id]);

      const p = await context.newPage();
      await clearPersistedState(p);
      await installStall(p, STALL_MS);
      await armBootProbe(p, { selector: SIDEBAR_ROW, minCount: 1 });
      await p.goto("/");

      const boot = await readBootProbe(p);
      if (boot.error || boot.ms === null) {
        throw new Error(`boot probe sample ${i}: ${boot.error ?? "no measurement"}`);
      }
      interactive.push(boot.ms);

      const fcp = await readFirstContentfulPaint(p);
      if (fcp === null) {
        throw new Error(
          `boot sample ${i}: the browser reported no 'first-contentful-paint' entry. ` +
            "Nothing was measured, and a boot bench with no paint timing is a boot bench that lies.",
        );
      }
      firstFrame.push(fcp);

      // "Usable" asserted, not assumed: the probe proves a row was PAINTED, this
      // proves the same row is something a hand can act on.
      await expect(p.locator(SIDEBAR_ROW).first()).toBeVisible();
      await expect(p.locator(SIDEBAR_ROW).first()).toBeEnabled();

      const sample = await measureInk(p, {
        gesture: "pointerdown",
        target: {
          selector: `[data-testid="chat-panel"][aria-label="${topic.name} panel"] [data-message-id]`,
          text: seeded[i]!,
        },
        act: () => p.locator(`[data-pane-id="${topic.id}"]`).first().click(),
      });
      coldOpen.push(sample.ms);
      await p.close();
    }

    gestures.boot_first_frame = describe(
      firstFrame,
      "app boot → something is painted",
      "PerformancePaintTiming 'first-contentful-paint', from navigation start",
    );
    gestures.boot_interactive = describe(
      interactive,
      "app boot → the sidebar can be used",
      "frame that presented the first enabled sidebar row, from navigation start",
    );
    gestures.topic_open_cold = describe(
      coldOpen,
      "open a topic, COLD (never revealed in this document)",
      "pointerdown → the frame that presented the topic's own message",
    );

    // ------------------------------------------------------------- the board --
    let seededSoFar = 0;
    for (const volume of BOARD_VOLUMES) {
      // Cumulative: reaching 500 by topping up 50 → 200 → 500 seeds 500 cards
      // once instead of 750 times.
      while (seededSoFar < volume) {
        const wave = Math.min(25, volume - seededSoFar);
        const created = await Promise.all(
          Array.from({ length: wave }, (_, k) =>
            request
              .post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, {
                data: { text: `Bench card ${seededSoFar + k} ${stamp}`, status: "todo" },
              })
              .then(async (res) => {
                expect(res.ok(), "the board API refused to seed a card").toBe(true);
                return ((await res.json()) as { id: string }).id;
              }),
          ),
        );
        taskIds.push(...created);
        seededSoFar += wave;
      }

      const samples: number[] = [];
      let rendered = 0;
      for (let i = 0; i < BOARD_SAMPLES; i++) {
        // The board ALONE in the group: one pane to hydrate, so the number is
        // the board's cost and not the cost of whatever else was open.
        await resetPaneStore(request, ["__board__"]);
        const p = await context.newPage();
        await clearPersistedState(p);
        await installStall(p, STALL_MS);
        await armBootProbe(p, { selector: TODO_CARD, minCount: volume });
        await p.goto("/");
        const result = await readBootProbe(p);
        if (result.error || result.ms === null) {
          throw new Error(`board paint ${volume} sample ${i}: ${result.error ?? "no measurement"}`);
        }
        samples.push(result.ms);
        rendered = await p.locator("[data-task-card]").count();
        await p.close();
      }
      gestures[`board_paint_${volume}`] = describe(
        samples,
        `paint the board with ${volume} tasks`,
        "navigation start → the frame that presented the n-th task card",
      );
      witness[`board_cards_rendered_${volume}`] = rendered;
      // A board that drew fewer cards than were seeded measured a shorter board.
      expect(rendered, `only ${rendered} cards reached the DOM for a volume of ${volume}`)
        .toBeGreaterThanOrEqual(volume);
    }

    // --------------------------------------------------------------- deliver --
    const payload = {
      $schema: "bench-latency-v1",
      measured_at: new Date().toISOString(),
      stall_ms: STALL_MS,
      samples_per_gesture: SAMPLES,
      board_samples_per_volume: BOARD_SAMPLES,
      machine: {
        platform: platform(),
        arch: arch(),
        cpus: cpus().length,
        cpu_model: cpus()[0]?.model ?? "unknown",
        memory_gb: Math.round(totalmem() / 1024 ** 3),
        browser: `${testInfo.project.use.browserName ?? "chromium"} ${context.browser()?.version() ?? "?"}`,
        // Asked of the browser, not copied from `test.use` above: a viewport
        // written by hand keeps saying 1600x900 the day somebody changes it, and
        // the board numbers depend on how many columns fit on screen.
        viewport: `${page.viewportSize()?.width ?? "?"}x${page.viewportSize()?.height ?? "?"}, ` +
          `${testInfo.project.use.headless === false ? "headed" : "headless"}`,
      },
      protocol: {
        warmup_loads_discarded: 1,
        cold_open_definition: "a chat pane never revealed in this document, with the board active at load",
        board_column: "todo — the working columns are never paged (boardOrder.ts, COLUMN_PAGE applies to review/done only)",
      },
      gestures,
      witness,
    };
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);

    testInfo.annotations.push({
      type: "bench-latency",
      description: Object.entries(gestures)
        .map(([k, v]) => `${k} ${v.medianMs}ms`)
        .join(" · "),
    });
    console.log(
      `[bench-latency] ` +
        Object.entries(gestures)
          .map(([k, v]) => `${k} ${v.medianMs}ms (${v.minMs}-${v.maxMs})`)
          .join("  ") +
        ` -> ${OUT_PATH}`,
    );

    // Harness sanity ONLY — there is no budget here, this is a report. A zero
    // would mean the probe fired before the app did anything, which is the one
    // result a latency measurement must never be allowed to publish. The sample
    // count is compared against the DECLARED constant and not against the array's
    // own length, which is a comparison that cannot fail.
    const expectedCount: Record<string, number> = {
      boot_first_frame: SAMPLES,
      boot_interactive: SAMPLES,
      topic_open_cold: SAMPLES,
      ...Object.fromEntries(BOARD_VOLUMES.map((v) => [`board_paint_${v}`, BOARD_SAMPLES])),
    };
    for (const [key, value] of Object.entries(gestures)) {
      expect(value.samples, `${key}: wrong number of samples`).toHaveLength(expectedCount[key]!);
      expect(value.minMs, `${key}: a sample measured <= 0 ms — the probe is lying`).toBeGreaterThan(0);
    }
  });
});

function describe(samples: number[], label: string, metric: string): Measured {
  return {
    label,
    metric,
    samples: samples.map(round1),
    medianMs: round1(median(samples)),
    minMs: round1(Math.min(...samples)),
    maxMs: round1(Math.max(...samples)),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Install the boot probe BEFORE the document runs, so the interval starts at the
 * document's time origin and not at whatever moment the driver managed to
 * evaluate something.
 *
 * The painted test is the ink one (non-empty box, not hidden by
 * `visibility`/`opacity`): this app lays out panes it is not showing, so mere
 * presence in the DOM would report an app as interactive while its sidebar is
 * still an empty rail.
 *
 * Resolves on the frame AFTER the one where the target is satisfied. rAF
 * callbacks run before their frame is painted, so the frame that observes the
 * target only proves the DOM is ready; the next timestamp is the first moment
 * the pixels are provably out. Same convention as `helpers/ink.ts`, so the two
 * benches round the same way.
 */
async function armBootProbe(page: Page, target: ProbeTarget): Promise<void> {
  await page.addInitScript(
    ({ target: want, timeoutMs }: { target: ProbeTarget; timeoutMs: number }) => {
      const paintedCount = (): number => {
        let n = 0;
        for (const el of Array.from(document.querySelectorAll(want.selector))) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.opacity === "0") continue;
          n++;
        }
        return n;
      };
      const promise = new Promise<ProbeResult>((resolve) => {
        const deadline = performance.now() + timeoutMs;
        let frames = 0;
        let domReady = false;
        const tick = (ts: number) => {
          frames++;
          if (domReady) {
            resolve({ ms: ts, frames, error: null });
            return;
          }
          if (paintedCount() >= want.minCount) {
            domReady = true;
          } else if (performance.now() > deadline) {
            resolve({
              ms: null,
              frames,
              error:
                `${want.selector} never reached ${want.minCount} painted matches in ${timeoutMs}ms ` +
                `(saw ${paintedCount()})`,
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      window.__benchBoot = { promise };
    },
    { target, timeoutMs: PROBE_TIMEOUT_MS },
  );
}

async function readBootProbe(page: Page): Promise<ProbeResult> {
  return page.evaluate(() => {
    const run = window.__benchBoot;
    if (!run) return Promise.resolve({ ms: null, frames: 0, error: "the boot probe was never installed" });
    return run.promise;
  });
}

/**
 * The browser's own first contentful paint, in milliseconds from navigation
 * start.
 *
 * AWAITED, not read once. The app paints nothing before React mounts, so the
 * first contentful paint is essentially the same frame that reveals the shell —
 * the frame the boot probe resolves on. The entry itself is queued to the
 * performance timeline a beat later, so a single synchronous read right after
 * the probe misses it about half the time (measured: one sample in two on the
 * first run of this bench). The observer with `buffered: true` covers both
 * orders; the deadline exists so a browser that never reports paint timing says
 * so instead of hanging.
 */
async function readFirstContentfulPaint(page: Page): Promise<number | null> {
  return page.evaluate(
    (timeoutMs: number) =>
      new Promise<number | null>((resolve) => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === "first-contentful-paint") {
              observer.disconnect();
              resolve(entry.startTime);
              return;
            }
          }
        });
        observer.observe({ type: "paint", buffered: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeoutMs);
      }),
    5_000,
  );
}

/**
 * Start every measured document from the SAME state: nothing in localStorage.
 *
 * Pages in one context share localStorage, and the pane store persists there.
 * Without this, sample n boots on the snapshot sample n-1 left behind — which is
 * not a detail: the first run of this bench measured the board with zero cards,
 * because the board page inherited "the chat tab is active" from the cold-open
 * step and the board never became visible at all. Cleared at document start, so
 * every sample hydrates from the server. The context is kept, so the HTTP cache
 * stays warm and the bundle is not re-downloaded per sample.
 */
async function clearPersistedState(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {
      // A document with no storage access has nothing to inherit either.
    }
  });
}

/**
 * Burn `ms` inside every animation frame of the first seconds of the document,
 * and inside every `pointerdown`. The falsification lever.
 *
 * Its SHAPE is the point. Lowering a number would only prove that `>` works;
 * this makes the app genuinely slow in the way a boot regression is slow — work
 * on the main thread per frame while the app comes up — so the measurement
 * itself has to notice, on every gesture this file publishes.
 */
async function installStall(page: Page, ms: number): Promise<void> {
  if (ms <= 0) return;
  await page.addInitScript(
    ({ burnMs, windowMs }: { burnMs: number; windowMs: number }) => {
      const burn = (): void => {
        const end = performance.now() + burnMs;
        // Busy-wait: a real main-thread stall, not a timer the scheduler can skip.
        while (performance.now() < end) { /* burn */ }
      };
      const until = performance.now() + windowMs;
      const frame = (): void => {
        burn();
        if (performance.now() < until) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      window.addEventListener("pointerdown", burn, true);
    },
    { burnMs: ms, windowMs: STALL_WINDOW_MS },
  );
}
