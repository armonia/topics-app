/**
 * Tokens per second of a session, from the growth of its OUTPUT counter.
 *
 * The counters Topics keeps (`native-usage-registry`, the transcripts) are
 * cumulative totals that move when a model round ends. So the rate is not an
 * instantaneous reading: it is the growth of the output counter over a short,
 * declared window (`RATE_WINDOW_MS`), divided by the time that growth took.
 * A session that finished a round inside the window shows that round's tokens
 * spread over the window; one that did not shows 0. Averaging over a window
 * keeps a long generation from reading as a spike followed by silence.
 *
 * Pure over the samples it was given: `now` comes from the caller, and the
 * tracker keeps only the samples the window can still use.
 */

/** The window the rate is averaged over, in ms. Printed next to the number. */
export const RATE_WINDOW_MS = 30_000;
/** Below this span between the two samples the rate is not stated: two reads a heartbeat apart say nothing. */
export const MIN_SPAN_MS = 3_000;
/** Samples older than window + this are dropped: one older than the window is kept as the baseline. */
const KEEP_SLACK_MS = 30_000;
const MAX_SAMPLES = 64;

interface Sample { at: number; out: number }

/**
 * `null` = not measurable (fewer than two samples, a span too short, or a
 * counter that went backwards, which means it was reset and the old baseline
 * is gone). 0 = measured, and nothing was produced.
 */
export function outputRate(samples: readonly Sample[], now: number, windowMs = RATE_WINDOW_MS): number | null {
  if (samples.length < 2) return null;
  const newest = samples[samples.length - 1]!;
  // The baseline is the newest sample at or before the window's start; with none that old, the oldest we have.
  const start = now - windowMs;
  let base = samples[0]!;
  for (const s of samples) {
    if (s.at <= start) base = s;
    else break;
  }
  const span = newest.at - base.at;
  if (span < MIN_SPAN_MS) return null;
  const delta = newest.out - base.out;
  if (delta < 0) return null;
  return delta / (span / 1000);
}

export interface RateTracker {
  /** Record the session's output counter as read at `now`. */
  observe(key: string, outputTokens: number, now: number): void;
  rate(key: string, now: number): number | null;
  /** The first time the key was observed: a session with no start of its own is "live since" this. */
  firstSeen(key: string): number | null;
  /** True when the counter moved at any time inside `ms` before `now`. */
  grewWithin(key: string, now: number, ms: number): boolean;
  /** Forget keys not observed since `before`. */
  prune(before: number): void;
}

export function createRateTracker(): RateTracker {
  const samples = new Map<string, Sample[]>();
  const first = new Map<string, number>();
  const lastGrowth = new Map<string, number>();
  return {
    observe(key, outputTokens, now) {
      if (!first.has(key)) first.set(key, now);
      const list = samples.get(key) ?? [];
      const prev = list[list.length - 1];
      if (prev && outputTokens > prev.out) lastGrowth.set(key, now);
      if (prev && outputTokens < prev.out) list.length = 0; // a reset: the old baseline would read as negative growth
      list.push({ at: now, out: outputTokens });
      // Keep one sample at or before the window start, drop what is older than that.
      const cut = now - RATE_WINDOW_MS - KEEP_SLACK_MS;
      while (list.length > 2 && list[1]!.at <= cut) list.shift();
      while (list.length > MAX_SAMPLES) list.shift();
      samples.set(key, list);
    },
    rate(key, now) {
      return outputRate(samples.get(key) ?? [], now);
    },
    firstSeen: (key) => first.get(key) ?? null,
    grewWithin(key, now, ms) {
      const at = lastGrowth.get(key);
      return at !== undefined && now - at <= ms;
    },
    prune(before) {
      for (const [key, list] of samples) {
        if ((list[list.length - 1]?.at ?? 0) < before) { samples.delete(key); first.delete(key); lastGrowth.delete(key); }
      }
    },
  };
}
