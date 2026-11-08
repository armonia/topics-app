/**
 * WHEN THE RESUME SWEEP RUNS, outside the boot (`lib/ripresa-boot.ts`).
 *
 * NOT ONLY AT BOOT. A turn cut by the watchdog, a stall or a provider error
 * while the server keeps running was never resumed until the next boot: on
 * 2026-09-04 the person had to write "riprendi" by hand. The same sweep runs
 * every five minutes; a resumed row carries its `ripreso` marker and a new
 * answer after it, so a sweep never resends twice. Chained, not on an
 * interval: one sweep can wait up to fifteen minutes on a stream.
 *
 * THE SWEEP RUNS EARLY WHEN A CUT JUST HAPPENED. The periodic tick is what
 * makes "riprende da solo" true at all; the nudge is what makes it true within
 * seconds instead of within five minutes. One pending nudge at a time.
 *
 * A HOLD DOES NOT STOP EITHER CLOCK. It walls its own provider's chats, and
 * the sweep defers those one by one: a resend into a spent usage window is a
 * 429 and one of the chain's attempts burnt for nothing. Stopping the whole
 * sweep on the Claude hold also stopped a Codex chat cut by the stale sweeper,
 * under a notice promising it resumes within minutes, for as long as the
 * Claude API was down (fifth review of card e30f35e4).
 */

const RESUME_SWEEP_MS = 5 * 60_000;
const RESUME_NUDGE_MS = 20_000;

/**
 * `nudge` runs the sweep within the nudge delay unless one is already
 * pending, `start` begins the periodic one a period from now, `stop` ends both.
 */
export function createResumeSweepClock(
  sweep: () => Promise<void>,
  opts: { periodMs?: number; nudgeMs?: number } = {},
): { nudge(): void; start(): void; stop(): void } {
  const periodMs = opts.periodMs ?? RESUME_SWEEP_MS;
  const nudgeMs = opts.nudgeMs ?? RESUME_NUDGE_MS;
  let pendingNudge: ReturnType<typeof setTimeout> | null = null;
  let tick: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function nudge(): void {
    if (pendingNudge || stopped) return;
    pendingNudge = setTimeout(() => {
      pendingNudge = null;
      sweep().catch((err) => console.error("[ripresa] nudged sweep failed", err));
    }, nudgeMs);
    pendingNudge.unref?.();
  }

  function start(): void {
    if (stopped) return;
    tick = setTimeout(() => {
      sweep()
        .catch((err) => console.error("[ripresa] periodic sweep failed", err))
        .finally(() => start());
    }, periodMs);
    tick.unref?.();
  }

  function stop(): void {
    stopped = true;
    if (pendingNudge) clearTimeout(pendingNudge);
    if (tick) clearTimeout(tick);
    pendingNudge = tick = null;
  }

  return { nudge, start, stop };
}
