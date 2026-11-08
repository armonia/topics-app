/**
 * One read of a headless SSE body, raced against "the route has deposited the
 * turn end and the body stayed silent for the grace".
 *
 * Every call owns at most ONE grace timer, and it is cleared the moment the
 * race is over. The previous inline version spawned a `while (true)` sleep loop
 * per read that nobody ever stopped: whenever the read won, the loop stayed
 * alive and woke every grace period until the session had another turn end —
 * for a finished card, until the server restarted. With one chunk per read (and
 * the SSE nudge adding up to a dozen comment chunks per silence) that was
 * hundreds of orphan loops per turn.
 */
export interface GraceTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: GraceTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function raceReadAgainstTurnEnd(
  read: () => Promise<{ done: boolean; value?: Uint8Array }>,
  isTurnEnded: () => boolean,
  graceMs: number,
  timers: GraceTimers = REAL_TIMERS,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let handle: unknown;
  // Re-armed after each silent grace while the end is not deposited yet; the
  // single `handle` always points at the one timer that is currently live.
  const grace = new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
    const arm = () => {
      handle = timers.setTimeout(() => {
        if (isTurnEnded()) resolve({ done: true });
        else arm();
      }, graceMs);
    };
    arm();
  });
  try {
    return await Promise.race([read(), grace]);
  } finally {
    // The race is decided (or the read threw): nothing may fire for it anymore.
    timers.clearTimeout(handle);
  }
}
