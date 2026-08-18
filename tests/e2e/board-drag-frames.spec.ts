import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/**
 * board-drag-frames.spec.ts - THE BENCH for frame time DURING a board drag.
 * It is not the gate: the gate is `scripts/check-drag-frames.ts`.
 *
 * WHY THIS SURFACE. The goal asks for a stable 60 FPS while dragging, and the
 * Kanban board is where dragging happens. It is also the surface with the
 * measured volume problem: 449 of 467 root cards on the live board are `done`,
 * and until the column was paged every one of them was live DOM that React
 * re-rendered on every `task:*` event and inside every drag move. Nothing in
 * this repo measured what the main thread does WHILE the pointer is down.
 *
 * WHY IT IS NOT COVERED BY `scroll-fluidity.spec.ts`. That bench scrolls a
 * virtualised transcript: the work per frame is virtuoso mounting rows. A drag
 * is a different machine - dnd-kit runs collision detection against every
 * registered droppable on every pointer move, the DragOverlay re-renders, and
 * the board's own state updates ride along. A regression in one is invisible to
 * the other, which is why this is a second bench and not a second budget on the
 * first.
 *
 * WHAT IT MEASURES, three numbers on the same gesture, because a drag stops
 * being 60 FPS in three ways that do not imply each other:
 *
 *   p95 frame     the frame time at the 95th percentile. The honest headline:
 *                 a median hides the one frame in twenty that a hand feels as
 *                 the card lagging behind the pointer.
 *   worst frame   the single longest gap. A 200 ms stall at the moment the
 *                 overlay mounts is invisible in a p95 over 60 frames.
 *   long tasks    how many blocks over 50 ms happened during the gesture. This
 *                 is the CAUSE, not the symptom: it says the defect is work on
 *                 the main thread rather than the compositor.
 *
 * WHY THE POINTER IS PACED TO THE FRAME. `page.mouse.move(..., { steps: n })`
 * fires n moves as fast as the protocol drains, which measures how fast CDP can
 * push events, not how the app answers a hand. Here every move is followed by
 * one real animation frame, so the gesture has the cadence a pointer actually
 * has and the gaps between frames mean what they say.
 *
 * WHY IT ASSERTS NO THRESHOLD. Same split as the fluidity bench: a red here
 * would be a statement about the machine (a loaded laptop delivers no frames),
 * and a suite that goes red for that gets ignored. This file fails only when
 * the BENCH did not work - no frames collected, the card never moved, the drop
 * never committed. The comparison against the budget lives in
 * `scripts/check-drag-frames.ts`, which reads the JSON written below.
 *
 * HOW TO SEE IT GO RED. `TOPICS_DRAG_JANK_MS=40` burns 40 ms inside a real
 * capture-phase `pointermove` listener, which is the exact shape of the defect
 * this bench exists to catch: work proportional to drag events. Lowering a
 * threshold would only prove that `>` works.
 */

const BASE = E2E_BASE;

/** Ad-hoc board id, like `inkbench-e2e001`: the general board aggregates every board. */
const BOARD_ID = "dragbench-e2e001";
/**
 * The seeded volume. 150 `done` is the live board's shape rounded down (449
 * measured on 2026-08-15), and it is the point of the bench: a drag on an empty
 * board measures nothing anybody has. `todo` needs one card per pass plus the
 * discarded warm-up.
 */
const DONE_SEEDED = 150;
const TODO_SEEDED = 8;
/** Timed passes. The MEDIAN of them is what the gate reads, so a stray GC on one pass cannot decide the verdict. */
const PASSES = 3;
/** Pointer moves per drag, one per animation frame: ~1 s of gesture at 60 Hz. */
const STEPS = 60;
/** Frames of the machine's idle cadence, measured on a blank page. */
const CALIBRATION_FRAMES = 60;

/**
 * Milliseconds burned inside every `pointermove`. The falsification lever.
 * Zero (the default) injects nothing.
 */
const JANK_MS = Number(process.env.TOPICS_DRAG_JANK_MS || 0);

const OUT_PATH = resolve(
  process.env.TOPICS_DRAG_OUT?.trim() || "test-results/drag-frames-measure.json",
);

interface Point {
  x: number;
  y: number;
}

interface RawPass {
  gaps: number[];
  longtasks: number[];
}

interface Pass {
  frames: number;
  p50_frame_ms: number;
  p95_frame_ms: number;
  worst_frame_ms: number;
  longtask_count: number;
  longtask_ms: number;
  /** Frames slower than the 60 FPS the goal asks for. Reported, not judged. */
  frames_over_16_7ms: number;
  pointer_moves: number;
  drag_span_px: number;
  cards_rendered: number;
  committed: boolean;
}

/** The recorder lives on the page between start and stop, so it needs a name there. */
interface DragRecorder {
  gaps: number[];
  longtasks: number[];
  running: boolean;
}
type RecorderWindow = Window & { __topicsDragRecorder?: DragRecorder };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Nearest rank, not interpolation: with 60 samples the p95 must be a frame that happened. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * s.length));
  return s[rank - 1]!;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * The machine's idle cadence, measured on a BLANK page.
 *
 * Outside the app on purpose. Measured inside, the app's own slowness (or the
 * slowness this bench injects) would widen the guard exactly when the defect
 * gets worse, and the gate would say "not measurable" in the one case where it
 * must say red.
 */
async function calibrate(page: Page, frames: number): Promise<number> {
  return page.evaluate(async (n: number) => {
    const gaps: number[] = [];
    await new Promise<void>((done) => {
      let i = 0;
      let last = 0;
      const tick = (t: number) => {
        gaps.push(t - last);
        last = t;
        if (++i >= n) return done();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame((t) => {
        last = t;
        requestAnimationFrame(tick);
      });
    });
    const s = gaps.sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }, frames);
}

/**
 * Burn `ms` inside every pointer move, before the bundle loads.
 *
 * This is the injected regression, and its SHAPE matters: a `setInterval` would
 * add spikes the gesture does not own, while a listener on `pointermove` makes
 * every drag move more expensive. That is what a board re-rendering all its
 * columns per move actually costs, so a gate that catches this catches the real
 * thing.
 */
async function injectDragJank(page: Page, ms: number): Promise<void> {
  if (ms <= 0) return;
  await page.addInitScript((burnMs: number) => {
    window.addEventListener(
      "pointermove",
      () => {
        const end = performance.now() + burnMs;
        while (performance.now() < end) {
          /* busy: that is the point */
        }
      },
      true,
    );
  }, ms);
}

/** One real animation frame. The pacing unit of the whole gesture. */
async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => done());
      }),
  );
}

async function startRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as RecorderWindow;
    const rec: DragRecorder = { gaps: [], longtasks: [], running: true };
    w.__topicsDragRecorder = rec;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) rec.longtasks.push(e.duration);
      });
      // `buffered: false`: only what happens INSIDE the gesture counts.
      observer.observe({ type: "longtask", buffered: false });
    } catch {
      // A browser with no longtask support must not kill the frame measurement.
      // The gate sees it as `longtask_count === 0` on an otherwise janky pass.
    }
    let last = 0;
    const tick = (t: number) => {
      if (last > 0) rec.gaps.push(t - last);
      last = t;
      if (!rec.running) {
        observer?.disconnect();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopRecorder(page: Page): Promise<RawPass> {
  return page.evaluate(() => {
    const w = window as RecorderWindow;
    const rec = w.__topicsDragRecorder;
    if (!rec) throw new Error("the frame recorder was never installed");
    rec.running = false;
    return { gaps: rec.gaps.slice(), longtasks: rec.longtasks.slice() };
  });
}

/** Straight-line interpolation between waypoints, one move per frame. */
async function pacedDrag(page: Page, path: Point[], steps: number): Promise<number> {
  const legs = path.length - 1;
  const perLeg = Math.max(1, Math.floor(steps / legs));
  let travelled = 0;
  let prev = path[0]!;
  for (let leg = 0; leg < legs; leg++) {
    const from = path[leg]!;
    const to = path[leg + 1]!;
    for (let i = 1; i <= perLeg; i++) {
      const f = i / perLeg;
      const x = from.x + (to.x - from.x) * f;
      const y = from.y + (to.y - from.y) * f;
      await page.mouse.move(x, y);
      await nextFrame(page);
      travelled += Math.hypot(x - prev.x, y - prev.y);
      prev = { x, y };
    }
  }
  return travelled;
}

test.describe("@nightly Kanban drag - frame time bench", () => {
  // Seeding 150 closed cards plus four paced drags does not fit 30 s.
  test.describe.configure({ timeout: 420_000 });
  // 1600 wide: at 1280 the five columns do not fit and the drop target of a
  // cross-column drag ends up behind a horizontal scroll.
  test.use({ viewport: { width: 1600, height: 900 } });

  const stamp = Date.now();
  const createdTasks: string[] = [];
  const todoIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const seed = async (text: string, done: boolean): Promise<string> => {
      const res = await request.post(`${BASE}/api/boards/${BOARD_ID}/tasks`, {
        data: { text, status: "todo" },
      });
      expect(res.ok(), `the board API refused to seed "${text}"`).toBe(true);
      const { id } = (await res.json()) as { id: string };
      createdTasks.push(id);
      if (done) {
        const patch = await request.patch(`${BASE}/api/boards/${BOARD_ID}/tasks/${id}`, {
          data: { status: "done" },
        });
        expect(patch.ok(), `could not close "${text}"`).toBe(true);
      }
      return id;
    };
    // In waves: 150 round trips in a row cost more than the measurement.
    const WAVE = 20;
    for (let i = 0; i < DONE_SEEDED; i += WAVE) {
      await Promise.all(
        Array.from({ length: Math.min(WAVE, DONE_SEEDED - i) }, (_, k) =>
          seed(`Drag bench closed ${i + k} ${stamp}`, true),
        ),
      );
    }
    for (let i = 0; i < TODO_SEEDED; i++) {
      todoIds.push(await seed(`Drag bench open ${i} ${stamp}`, false));
    }
  });

  test.afterAll(async ({ request }) => {
    for (let i = 0; i < createdTasks.length; i += 20) {
      await Promise.all(
        createdTasks.slice(i, i + 20).map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})),
      );
    }
  });

  // `@nightly` on the test title and not only on the describe: the PR tier
  // excludes it with `grepInvert: /@nightly/`, and every other tagged test in
  // this suite carries it there. A bench that seeds 150 cards and drags four
  // times has no business on the pull-request path; it is the gate script that
  // runs it, on demand.
  test("measures frame time while a card is dragged across columns @nightly", async ({ page }, testInfo) => {
    await resetPaneStore(page.request, ["__board__"]);

    // Calibration on a SEPARATE blank page: `addInitScript` is per-page, so the
    // injected slowness never reaches this number and it stays what it must be,
    // a verdict on the machine rather than on the app.
    const blank = await page.context().newPage();
    await blank.goto("about:blank");
    const calibration_gap_ms = await calibrate(blank, CALIBRATION_FRAMES);
    await blank.close();

    await injectDragJank(page, JANK_MS);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();

    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible({ timeout: 20_000 });
    const todoBody = page.getByTestId("kanban-column-body-todo");
    const backlogBody = page.getByTestId("kanban-column-body-backlog");
    const inProgressBody = page.getByTestId("kanban-column-body-in_progress");
    await expect(todoBody.locator(`[data-task-card="${todoIds[0]}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(backlogBody).toBeVisible();
    await expect(inProgressBody).toBeVisible();

    const backlogBox = (await backlogBody.boundingBox())!;
    const inProgressBox = (await inProgressBody.boundingBox())!;

    /**
     * One pass: grab a card, cross the board and drop it in Backlog.
     *
     * The route goes through In Progress and back, so dnd-kit runs collision
     * detection against several columns instead of the two a straight line
     * would touch. Backlog is the drop target and not In Progress because a
     * drop on In Progress is REDIRECTED to Todo by design (BOARD-18), and a
     * pass whose card does not change column has no witness that the gesture
     * landed.
     *
     * The grab point is the card's TOP, not its centre: the sensors ignore
     * fields and command buttons (`dndSensors.ts`), and the centre of a card
     * offering choices is a button, from which the drag never starts.
     */
    const onePass = async (cardId: string): Promise<Pass> => {
      const card = page.locator(`[data-task-card="${cardId}"]`);
      await card.scrollIntoViewIfNeeded();
      const box = (await card.boundingBox())!;
      const grab: Point = { x: box.x + box.width / 2, y: box.y + 12 };
      const cards_rendered = await page.locator("[data-task-card]").count();

      await page.mouse.move(grab.x, grab.y);
      await startRecorder(page);
      await page.mouse.down();
      // dnd-kit activates after 4 px: this move is what starts the drag, and
      // the frame that mounts the DragOverlay is one of the most expensive of
      // the gesture, so it is inside the recording.
      await page.mouse.move(grab.x + 8, grab.y + 8);
      await nextFrame(page);

      const span = await pacedDrag(
        page,
        [
          { x: grab.x + 8, y: grab.y + 8 },
          { x: inProgressBox.x + inProgressBox.width / 2, y: inProgressBox.y + inProgressBox.height / 3 },
          { x: backlogBox.x + backlogBox.width / 2, y: backlogBox.y + backlogBox.height / 2 },
        ],
        STEPS,
      );

      await page.mouse.up();
      // Two frames after the drop: the commit re-render happens on one of them,
      // and a longtask entry is delivered asynchronously, so stopping instantly
      // would drop exactly the most expensive part of the gesture.
      await nextFrame(page);
      await nextFrame(page);
      const raw = await stopRecorder(page);

      // Polled by hand rather than with `expect.poll`, because "the drop did not
      // commit" must become a WITNESS in the JSON and not an exception: the
      // measurement of the other passes is still worth writing down, and the
      // gate is the one that decides what an incomplete bench is worth. Paced
      // on animation frames, so no fixed sleep enters the file.
      let committed = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const r = await page.request.get(`${BASE}/api/boards/${BOARD_ID}/tasks/${cardId}`);
        const body = (await r.json()) as { task?: { status?: string } };
        if (body.task?.status === "backlog") {
          committed = true;
          break;
        }
        await nextFrame(page);
      }

      return {
        frames: raw.gaps.length,
        p50_frame_ms: round(percentile(raw.gaps, 0.5)),
        p95_frame_ms: round(percentile(raw.gaps, 0.95)),
        worst_frame_ms: round(raw.gaps.length ? Math.max(...raw.gaps) : 0),
        longtask_count: raw.longtasks.length,
        longtask_ms: round(raw.longtasks.reduce((a, b) => a + b, 0)),
        frames_over_16_7ms: raw.gaps.filter((g) => g > 1000 / 60).length,
        pointer_moves: STEPS,
        drag_span_px: round(span, 0),
        cards_rendered,
        committed,
      };
    };

    // Warm-up, DISCARDED. The first drag of a board's life mounts the overlay
    // portal, builds dnd-kit's droppable rectangles and pays every lazy import
    // on the path. That cost is real and it is paid once, so measuring it would
    // measure the first drag ever rather than dragging.
    await onePass(todoIds[0]!);

    const passes: Pass[] = [];
    for (let i = 0; i < PASSES; i++) passes.push(await onePass(todoIds[i + 1]!));

    // The ways this bench can stop measuring while staying green. A red here
    // speaks about the bench; the budget is judged elsewhere.
    for (const p of passes) {
      expect(p.frames, "the recorder collected no frames").toBeGreaterThan(STEPS / 2);
      expect(p.drag_span_px, "the pointer did not travel").toBeGreaterThan(200);
      expect(p.committed, "the drop never reached the server: no drag was measured").toBe(true);
    }

    const measure = {
      $schema: "drag-frames-v1",
      surface: "kanban-board-drag",
      measured_at: new Date().toISOString(),
      jank_injected_ms: JANK_MS,
      protocol: {
        passes: PASSES,
        warmup_passes: 1,
        steps_per_drag: STEPS,
        done_seeded: DONE_SEEDED,
        todo_seeded: TODO_SEEDED,
        route: "todo card -> in progress -> backlog, one pointer move per frame",
      },
      calibration_gap_ms: round(calibration_gap_ms),
      median: {
        p95_frame_ms: round(median(passes.map((p) => p.p95_frame_ms))),
        p50_frame_ms: round(median(passes.map((p) => p.p50_frame_ms))),
        worst_frame_ms: round(median(passes.map((p) => p.worst_frame_ms))),
        longtask_count: round(median(passes.map((p) => p.longtask_count))),
        longtask_ms: round(median(passes.map((p) => p.longtask_ms))),
        frames_over_16_7ms: round(median(passes.map((p) => p.frames_over_16_7ms))),
      },
      // The witnesses, in plain sight in the JSON: whoever reads the number
      // also sees that a card really moved while it was taken.
      witness: {
        frames: round(median(passes.map((p) => p.frames))),
        pointer_moves: STEPS,
        drag_span_px: round(median(passes.map((p) => p.drag_span_px)), 0),
        cards_rendered: round(median(passes.map((p) => p.cards_rendered)), 0),
        drops_committed: passes.filter((p) => p.committed).length,
      },
      passes,
    };

    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(measure, null, 2)}\n`);
    testInfo.annotations.push({
      type: "drag-frames",
      description:
        `p95 ${measure.median.p95_frame_ms}ms, worst ${measure.median.worst_frame_ms}ms, ` +
        `${measure.median.longtask_count} long tasks, ${measure.witness.cards_rendered} cards drawn`,
    });
    console.log(
      `[drag] p95 ${measure.median.p95_frame_ms}ms  worst ${measure.median.worst_frame_ms}ms  ` +
        `long tasks ${measure.median.longtask_count}  (calibration ${measure.calibration_gap_ms}ms) -> ${OUT_PATH}`,
    );
  });
});
