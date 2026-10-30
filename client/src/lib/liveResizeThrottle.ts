/**
 * How a pane streams its size to the remote page WHILE it is being resized.
 *
 * It was a 150 ms debounce: every ResizeObserver tick restarted the timer, so
 * during a drag the page kept its old width and caught up only once the hand
 * stopped (TOPIC-BROWSER-01). A throttle sends the size as it goes: the first
 * change leaves at once, the ones after it at most every `intervalMs`, and the
 * last one always leaves, because the trailing timer reads the box when it
 * fires and not when it was set.
 */

/** At most one resize every 50 ms during a drag: about every third frame. */
export const LIVE_RESIZE_INTERVAL_MS = 50;

export interface LiveResizeClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: LiveResizeClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LiveResizeThrottle {
  /** The size changed: `run` happens now, or once the interval is over. */
  schedule(): void;
  /** Drop the pending run (the element went away). */
  cancel(): void;
}

export function createLiveResizeThrottle(
  run: () => void,
  intervalMs: number = LIVE_RESIZE_INTERVAL_MS,
  clock: LiveResizeClock = realClock,
): LiveResizeThrottle {
  let lastRun = -Infinity;
  let timer: unknown = null;
  const fire = () => {
    timer = null;
    lastRun = clock.now();
    run();
  };
  return {
    schedule() {
      if (timer !== null) return; // a run is already due: it will read the newest size
      const wait = intervalMs - (clock.now() - lastRun);
      if (wait <= 0) fire();
      else timer = clock.setTimer(fire, wait);
    },
    cancel() {
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
    },
  };
}
