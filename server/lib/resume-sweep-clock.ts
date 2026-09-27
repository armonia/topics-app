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
 * seconds instead of within five minutes. One pending nudge at a time, and a
 * hold in force still wins: a resend into a spent usage window is a 429 and
 * one of the chain's attempts burnt for nothing.
 */
import { holdUntilLabel, providerHold } from "./provider-hold";

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
      if (providerHold()) return;
      sweep().catch((err) => console.error("[ripresa] nudged sweep failed", err));
    }, nudgeMs);
    pendingNudge.unref?.();
  }

  function start(): void {
    if (stopped) return;
    tick = setTimeout(() => {
      // The plan's usage window is spent: a resend now would end on the same
      // 429 and spend one of the chain's attempts for nothing. The sweep after
      // the reset picks the same rows up.
      const hold = providerHold();
      if (hold) {
        console.log(`[ripresa] sweep rinviato: ${hold.reason}, riparte alle ${holdUntilLabel(hold)}`);
        start();
        return;
      }
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
