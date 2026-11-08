/**
 * The shape in which the desktop shell reports how long its interactions took.
 *
 * Event Timing only reports the events slower than a threshold (16 ms here), so
 * a list of its entries is the list of the SLOW ones and says nothing about how
 * many fast ones there were. A percentile needs both halves: the slow ones
 * live in this histogram, the total comes from the browser's own event counts.
 * The client fills it (`client/src/lib/eventTiming.ts`) and the gate reads it
 * back from the server log (`scripts/check-inp-shell.ts`), so the arithmetic
 * lives in one place.
 *
 * Browsers round these durations to 8 ms, so the edges below are multiples of 8.
 */

/** Interactions at or above this many milliseconds are the ones Event Timing reports. */
export const SLOW_INTERACTION_MS = 16;

/** Lower edge of each bucket; the last bucket is open on top. */
export const INTERACTION_BUCKET_EDGES: readonly number[] = [16, 24, 32, 40, 48, 64, 80, 96, 128, 160, 200, 256, 320, 512];

/** Counts of slow interactions per bucket, one slot for each edge. */
export type InteractionHistogram = number[];

export function emptyInteractionHistogram(): InteractionHistogram {
  return INTERACTION_BUCKET_EDGES.map(() => 0);
}

/** Bucket of a duration, or -1 when the interaction was not slow. */
export function interactionBucket(durationMs: number): number {
  if (!(durationMs >= SLOW_INTERACTION_MS)) return -1;
  let index = 0;
  while (index + 1 < INTERACTION_BUCKET_EDGES.length && durationMs >= INTERACTION_BUCKET_EDGES[index + 1]!) index++;
  return index;
}

/** Counts one slow interaction. Faster ones are not kept: `total` carries them. */
export function addInteraction(histogram: InteractionHistogram, durationMs: number): void {
  const index = interactionBucket(durationMs);
  if (index >= 0) histogram[index] = (histogram[index] ?? 0) + 1;
}

/** Element-wise sum of histograms from different page loads. */
export function mergeInteractionHistograms(histograms: readonly (readonly number[])[]): InteractionHistogram {
  const sum = emptyInteractionHistogram();
  for (const histogram of histograms) {
    for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (histogram[i] ?? 0);
  }
  return sum;
}

/**
 * The duration under which a fraction `fraction` of `total` interactions fell.
 *
 * Counts from the slowest end: the interactions above the fraction are
 * `ceil((1 - fraction) * total)`, and the answer is the upper edge of the
 * bucket that holds the last of them, so it never understates. When fewer
 * interactions than that were slow, the fraction lies below what Event Timing
 * reports and the answer is the reporting threshold itself ("under 16 ms").
 * The open-ended top bucket answers with its lower edge. Returns null when
 * nothing was counted at all, which is not the same as fast.
 */
export function interactionPercentile(histogram: readonly number[], total: number, fraction: number): number | null {
  if (!(total > 0)) return null;
  // In thousandths, so that 5% of 100 is 5 and not the 5.000000000000004 that
  // `(1 - 0.95) * 100` is, which would count one interaction too many.
  const above = Math.ceil((total * Math.round((1 - fraction) * 1000)) / 1000);
  if (above <= 0) return 0;
  let counted = 0;
  for (let i = INTERACTION_BUCKET_EDGES.length - 1; i >= 0; i--) {
    counted += histogram[i] ?? 0;
    if (counted >= above) return INTERACTION_BUCKET_EDGES[i + 1] ?? INTERACTION_BUCKET_EDGES[i]!;
  }
  return SLOW_INTERACTION_MS;
}
