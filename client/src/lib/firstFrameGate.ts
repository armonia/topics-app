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
