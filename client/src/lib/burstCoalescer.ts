/**
 * A burst of events, a single read.
 *
 * The global feed of the board (`GET /api/all-boards/tasks`) is re-read on
 * every `task:created|updated|deleted` event of the WebSocket, and until now
 * one by one: N events, N re-reads. Measured on 2026-08-14 on this machine: the
 * feed weighs 1.44 MB and costs the server 175 ms, and the busiest minute of
 * the last three days holds 24 task updates, that is 34.6 MB downloaded and
 * 4.2 s of server to show a state that in the end is ONE. Every response also
 * rewrites the store, so every surface of the board repaints 24 times.
 *
 * The burst is not a rare case: it is the normal shape of the work in this app,
 * where it is the agents that move the cards.
 *
 * ## How it coalesces, and why this way
 *
 * RISING edge plus a tail: the first event fires right away, the ones that
 * arrive within the window become ONE single re-read afterwards. A pure
 * debounce (wait-then-read) would be simpler and wrong: it would delay the
 * single event too, which is the case where the human has just moved a card and
 * is watching the screen. This way the single one stays immediate and the burst
 * costs two reads instead of twenty-four.
 *
 * The last state is never lost: if even one single event arrived during the
 * window, the tail starts again. The ceiling is one read per window, the floor
 * is that the last read is always LATER than the last event.
 *
 * ## Out of order
 *
 * Two overlapping reads can come back inverted (the first slower than the
 * second), and whoever writes last wins: the screen would stay behind with no
 * later event to correct it. The coalescer numbers the runs and discards the
 * result of a run that has already been superseded.
 *
 * `now`/`schedule` are injectable so that the test can drive time without
 * sleeping: a test that really waits 400 ms to check a 400 ms window is a test
 * that dies the day the machine is busy.
 */

export interface CoalescerOptions {
  /** Milliseconds during which the events after the first one merge into one. */
  windowMs: number;
  /** The work to do. If it throws, the error belongs to the caller: here it is ignored. */
  run: () => Promise<void>;
  /** Injectable for the tests. Defaults to the global `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Injectable for the tests. Default: `clearTimeout`. */
  cancel?: (handle: unknown) => void;
}

export interface Coalescer {
  /** Signals that there is something new to read. */
  trigger: () => void;
  /** Shuts down the pending tail (to be called on unmount). */
  dispose: () => void;
}

export function createBurstCoalescer(opts: CoalescerOptions): Coalescer {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let handle: unknown = null;
  let pending = false;
  let disposed = false;

  const fire = (): void => {
    if (disposed) return;
    void opts.run().catch(() => { /* the caller decides what to do with an error */ });
    handle = schedule(() => {
      handle = null;
      if (!pending || disposed) return;
      pending = false;
      fire();
    }, opts.windowMs);
  };

  return {
    trigger(): void {
      if (disposed) return;
      // Window open: this event merges with the others and starts again later.
      if (handle !== null) { pending = true; return; }
      fire();
    },
    dispose(): void {
      disposed = true;
      pending = false;
      if (handle !== null) { cancel(handle); handle = null; }
    },
  };
}

/**
 * The guardian of the order: it wraps an async read so that the result of a
 * SUPERSEDED run never writes over a more recent one.
 *
 * It is needed because `fetch` does not promise the order of arrival: with a
 * read of 175 ms and a window of 400 ms the overlap is rare, but under load (or
 * on a slow network) it happens, and it is exactly the condition in which the
 * screen stays behind with no further event to correct it.
 */
export function latestWins<T>(apply: (value: T) => void): (load: () => Promise<T>) => Promise<void> {
  let latest = 0;
  return async (load) => {
    const mine = ++latest;
    const value = await load();
    if (mine !== latest) return;
    apply(value);
  };
}
