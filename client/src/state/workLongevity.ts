/**
 * Pure derivation for "how long since this session last updated, and is that long
 * enough to read as stale?". Feeds the sidebar's `labeled` streaming indicator so a
 * session that hasn't produced an update in 18 minutes no longer looks identical to
 * one that just did.
 *
 * The signal is TIME SINCE THE LAST UPDATE (sessionLastActivity), not time since the
 * phase started: a turn actively streaming keeps bumping its last-activity, so it
 * never reads as stale; only a turn that's gone quiet — e.g. parked waiting on a
 * background run whose Stop hook never fired — does. The sidebar spinner is binary,
 * so today the user can't tell "still updating" from "wedged". Showing "agg. Xm fa"
 * and, past a threshold, a calmer "no updates in a while" treatment makes that
 * legible — no server change (the actual phantom-phase healing is server-side and
 * out of scope here).
 *
 * Pure + deterministic on (lastUpdate, now) so the thresholds are unit-tested.
 */

/** Below this the spinner stays bare — a just-updated turn needs no readout. */
export const WORK_ELAPSED_AFTER_MS = 60_000; // 1 min since last update
/** No update for this long → the indicator reads as "in attesa / forse ferma". */
export const WORK_STALE_AFTER_MS = 600_000; // 10 min since last update

export interface WorkLongevity {
  /** now - lastUpdate, clamped to ≥ 0. 0 when `lastUpdate` is missing/invalid. */
  elapsedMs: number;
  /** Render the "agg. Xm fa" readout next to the glyph. */
  showElapsed: boolean;
  /** Escalate to the calm "no recent updates / possibly waiting" treatment. */
  isStale: boolean;
}

/**
 * @param lastUpdate epoch-ms the session last did something (sessionLastActivity)
 * @param now        epoch-ms "now" (a shared 1-per-app tick, not per-row)
 */
export function deriveWorkLongevity(lastUpdate: number | undefined, now: number): WorkLongevity {
  // No trustworthy last-update → no readout, no escalation. A future timestamp
  // (clock skew) clamps to 0 rather than showing a negative/absurd duration.
  if (typeof lastUpdate !== 'number' || !Number.isFinite(lastUpdate) || lastUpdate <= 0) {
    return { elapsedMs: 0, showElapsed: false, isStale: false };
  }
  const elapsedMs = Math.max(0, now - lastUpdate);
  return {
    elapsedMs,
    showElapsed: elapsedMs >= WORK_ELAPSED_AFTER_MS,
    isStale: elapsedMs >= WORK_STALE_AFTER_MS,
  };
}

/**
 * Minute-granularity duration for the sidebar chip: "2m", "18m", "1h 02m". No
 * seconds on purpose — the readout only appears past WORK_ELAPSED_AFTER_MS and a
 * seconds-ticking label in the sidebar reads as noise (and would force a 1s tick).
 */
export function formatElapsedCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalM = Math.floor(ms / 60_000);
  if (totalM < 60) return `${Math.max(1, totalM)}m`;
  const h = Math.floor(totalM / 60);
  return `${h}h ${String(totalM % 60).padStart(2, '0')}m`;
}
