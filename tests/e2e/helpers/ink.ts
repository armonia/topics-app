/**
 * CLICK → INK: how many milliseconds pass between the gesture and the first
 * frame in which the app has PAINTED the answer.
 *
 * WHY THIS EXISTS. "Fast", "instant", "fluid" are adjectives that cannot fail,
 * so work measured against them never ends. This helper replaces them with a
 * number that a command can compare. It is deliberately NOT a wall-clock
 * `Date.now()` around a Playwright action (the way PERF-02 measures a topic
 * switch): that number includes the CDP round-trips of the driver and the
 * polling granularity of the locator that waits for the result, which are the
 * harness, not the app.
 *
 * THE TWO ENDS OF THE INTERVAL.
 *
 *   t0 — the GESTURE. Taken from `event.timeStamp` of the trusted DOM event
 *        Playwright dispatches, which shares the page's time origin with
 *        `performance.now()`. It is the event's CREATION time, not the time its
 *        handler ran, so anything that blocks the main thread between the input
 *        and React's handler is INSIDE the measurement — which is the point.
 *        (Reading `performance.now()` inside our own listener would silently
 *        exclude every listener registered before ours.)
 *
 *   t1 — the INK. A `requestAnimationFrame` loop polls the target every frame.
 *        rAF callbacks run BEFORE the paint of their frame, so seeing the target
 *        satisfied at frame F only proves the DOM is ready; frame F is the one
 *        that puts it on screen. t1 is therefore the timestamp of frame F+1 —
 *        the first moment at which the pixels are provably out. This rounds UP
 *        by at most one frame; the budget is written knowing that.
 *
 * WHAT COUNTS AS PAINTED. Presence in the DOM is not ink: this app keeps
 * background panes mounted and hides them with `display:none`
 * (StandaloneChatGroup), so a naive `querySelector` would report a tab switch as
 * zero milliseconds — a measurement that says the opposite of the truth. A match
 * must have a non-empty border box AND not be hidden by `visibility`/`opacity`,
 * and may be required to contain specific text (the drawer mounts a skeleton
 * before the task's title arrives — the skeleton is not the answer).
 *
 * ARMING IS ASSERTED. `armInk` refuses to start when the target is ALREADY
 * painted, because that measurement would return ~0ms whatever the app did.
 */
import type { Page } from "@playwright/test";

/** Which input event opens the interval. */
export type InkGesture = "pointerdown" | "keydown";

/** The ink: what has to be on screen for the interaction to be answered. */
export interface InkTarget {
  /** CSS selector the painted answer must match. */
  selector: string;
  /** Text the matched element must contain. Used when a shell paints before its content. */
  text?: string;
  /** How many painted matches are required. Default 1. Used for "one more message". */
  minCount?: number;
}

/** One measured interaction. */
export interface InkSample {
  /** Gesture → painted answer, in milliseconds. */
  ms: number;
  /** Animation frames observed while waiting. */
  frames: number;
}

interface InkRunResult {
  ms: number | null;
  frames: number;
  error: string | null;
}

interface InkRunHandle {
  promise: Promise<InkRunResult>;
}

declare global {
  interface Window {
    __inkRun?: InkRunHandle;
  }
}

/** Default ceiling for one measurement before it is reported as "never painted". */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Install the probe and start watching. Returns as soon as the listener and the
 * frame loop are live, so the caller can perform the gesture next.
 *
 * Throws when the target is already painted — see the file header.
 */
export async function armInk(
  page: Page,
  gesture: InkGesture,
  target: InkTarget,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const alreadyPainted = await page.evaluate(paintedCountInPage, target);
  const required = target.minCount ?? 1;
  if (alreadyPainted >= required) {
    throw new Error(
      `armInk: the target is ALREADY painted (${alreadyPainted} >= ${required} matches for ` +
        `${describeTarget(target)}). Measuring from here would return ~0ms no matter how slow ` +
        `the app is. Close/reset the surface before arming.`,
    );
  }

  await page.evaluate(
    ({ gesture: gestureName, target: want, timeoutMs: budget }) => {
      const paintedCount = (): number => {
        let n = 0;
        for (const el of Array.from(document.querySelectorAll(want.selector))) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.opacity === "0") continue;
          if (want.text && !(el.textContent ?? "").includes(want.text)) continue;
          n++;
        }
        return n;
      };
      const required = want.minCount ?? 1;

      let t0: number | null = null;
      const onGesture = (ev: Event) => {
        // `ev.timeStamp`, not `performance.now()`: see the file header.
        if (t0 === null) t0 = ev.timeStamp;
      };
      window.addEventListener(gestureName, onGesture, true);

      const promise = new Promise<InkRunResult>((resolve) => {
        const deadline = performance.now() + budget;
        let frames = 0;
        let domReady = false;
        const finish = (ms: number | null, error: string | null) => {
          window.removeEventListener(gestureName, onGesture, true);
          resolve({ ms, frames, error });
        };
        const tick = (ts: number) => {
          frames++;
          if (domReady) {
            // The frame that painted the answer has now been presented.
            finish(t0 === null ? null : ts - t0, t0 === null ? `no '${gestureName}' captured` : null);
            return;
          }
          if (t0 !== null && paintedCount() >= required) {
            domReady = true;
          } else if (performance.now() > deadline) {
            finish(
              null,
              t0 === null
                ? `no '${gestureName}' event in ${budget}ms`
                : `the ink (${want.selector}) never painted within ${budget}ms`,
            );
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      window.__inkRun = { promise };
    },
    { gesture, target, timeoutMs },
  );
}

/** Await the armed measurement. Call after the gesture has been performed. */
export async function readInk(page: Page): Promise<InkSample> {
  const result = await page.evaluate(() => {
    const run = window.__inkRun;
    if (!run) return Promise.resolve({ ms: null, frames: 0, error: "no armed measurement" });
    return run.promise;
  });
  if (result.error || result.ms === null) {
    throw new Error(`readInk: ${result.error ?? "no measurement"}`);
  }
  return { ms: result.ms, frames: result.frames };
}

/** Arm, perform the gesture, and read the result. */
export async function measureInk(
  page: Page,
  opts: {
    gesture: InkGesture;
    target: InkTarget;
    act: () => Promise<void>;
    timeoutMs?: number;
  },
): Promise<InkSample> {
  await armInk(page, opts.gesture, opts.target, opts.timeoutMs);
  await opts.act();
  return readInk(page);
}

/**
 * Block the main thread for `ms` on every gesture — the falsification lever.
 *
 * A gate that has only ever been seen green proves nothing. Overriding the
 * threshold would only prove that `>` works; this makes the APP genuinely slow,
 * so the measurement itself has to notice. Registered in the capture phase on
 * `window`, i.e. ahead of React's root handler, so the stall lands between the
 * input and the render — exactly where a real regression would.
 */
export async function installInkStall(page: Page, ms: number): Promise<void> {
  await page.evaluate((blockMs) => {
    const stall = () => {
      const until = performance.now() + blockMs;
      // Busy-wait: a real main-thread stall, not a timer the scheduler can skip.
      while (performance.now() < until) { /* burn */ }
    };
    window.addEventListener("pointerdown", stall, true);
    window.addEventListener("keydown", stall, true);
  }, ms);
}

/** The median, which is what "how long does it usually take" means. */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median: no samples");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Counts painted matches in the page. Shared by the arm-time guard. */
function paintedCountInPage(want: InkTarget): number {
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(want.selector))) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.opacity === "0") continue;
    if (want.text && !(el.textContent ?? "").includes(want.text)) continue;
    n++;
  }
  return n;
}

function describeTarget(target: InkTarget): string {
  const bits = [target.selector];
  if (target.text) bits.push(`text ${JSON.stringify(target.text)}`);
  if (target.minCount) bits.push(`min ${target.minCount}`);
  return bits.join(" + ");
}
