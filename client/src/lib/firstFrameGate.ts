/**
 * Wait for something the first frame needs, but never for long.
 *
 * The chunks of the panes on screen are asked for before React renders; a
 * cached chunk still settles in a LATER task than React's first render, so
 * rendering right away paints the fallbacks and the real bodies a frame or
 * two later (measured 2026-09-05: 240 ms of spinner per tile with every chunk
 * cached at 110 ms). A complete first frame a few dozen milliseconds later
 * beats an earlier one with three spinners in it - but a chunk that never
 * settles must not hold the whole app hostage, hence the cap: past it the app
 * renders anyway, and the boundaries do their job as before.
 */

/** Upper bound on how long the first render waits for the warm chunks. */
export const FIRST_FRAME_WARM_CAP_MS = 300;

export type FirstFrameGateOutcome = 'settled' | 'capped';

/**
 * Resolves with `settled` when `pending` settles first, `capped` when the cap
 * expires first. Never rejects: a failed chunk is the boundary's business.
 */
export function awaitWithCap(pending: Promise<unknown>, capMs: number): Promise<FirstFrameGateOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('capped'), capMs);
    pending.then(
      () => { clearTimeout(timer); resolve('settled'); },
      () => { clearTimeout(timer); resolve('settled'); },
    );
  });
}

/** Where {@link recordFirstFrameGate} leaves its one line, for a probe to read. */
export const FIRST_FRAME_GATE_KEY = 'topics:first-frame-gate';

/**
 * WHAT THE GATE ITSELF COST, WRITTEN DOWN INSTEAD OF THROWN AWAY.
 *
 * `awaitWithCap` already knew whether the chunks had arrived or the cap had
 * cut the wait, and the caller dropped that answer on the floor. From the
 * outside the wait is invisible: what a probe can see is "the shell painted
 * at 224 ms", a number that mixes the gate in with parsing, hydration and
 * React's own first render, so a change to the WARM SET could not be told
 * apart from noise in the rest of the boot.
 *
 * One row: `settled:<ms>` when the chunks landed first (the number is how
 * long the render actually waited), `capped` when they did not and the app
 * rendered anyway at {@link FIRST_FRAME_WARM_CAP_MS}.
 *
 * Two surfaces, because they answer different questions. The `performance`
 * measure puts the wait on the timeline of a profile taken in the real app,
 * next to the paints; the `sessionStorage` row survives into the loaded page
 * so a Playwright probe can read the number after the fact without a
 * debugger attached. sessionStorage and not localStorage on purpose - this
 * is a fact about THIS load, and a value that outlived its tab would be read
 * later as if it were fresh.
 *
 * Deliberately NOT a fourth dev probe: no flag to arm, no fetch, no server
 * round trip. A probe that costs a request is a probe that moves the thing
 * it measures, which is the very cost this work is removing from the boot.
 */
export function recordFirstFrameGate(outcome: FirstFrameGateOutcome, waitedMs: number): void {
  const row = outcome === 'settled' ? `settled:${Math.round(waitedMs)}` : 'capped';
  try {
    performance.measure('topics:first-frame-gate', {
      start: Math.max(0, performance.now() - waitedMs),
      detail: row,
    });
  } catch {
    /* an engine without the options form of `measure` still gets the row below */
  }
  try {
    sessionStorage.setItem(FIRST_FRAME_GATE_KEY, row);
  } catch {
    /* private mode / storage denied: the measure above is the fallback */
  }
}
