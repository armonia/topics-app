/**
 * IS A FOOTPRINT GROWING, AND BY HOW MUCH PER MINUTE?
 *
 * The arithmetic two memory tools share: `scripts/mem-growth.ts`, which only
 * ever printed a curve, and `scripts/renderer-growth-check.ts`, which turns the
 * same curve into a verdict with an exit code. Both read `phys_footprint` (the
 * "Memory" column of Activity Monitor) because on a machine with swap in use
 * the resident size describes the hole, not the process.
 *
 * Nothing here samples anything: these are pure functions over a series, so
 * the verdict is testable without a Mac and without waiting minutes.
 */

/** One reading: milliseconds since the start of the series, and megabytes. */
export interface FootprintPoint {
  t: number;
  mb: number;
}

/** A process worth following, as `scripts/mem-report.ts --json` reports it. */
export interface ProcessRow {
  pid: number;
  name: string;
  footprintMB: number;
}

/** The WebKit process name that renders the app's window on macOS. */
export const RENDERER_PROCESS_NAME = "com.apple.WebKit.WebContent";

/**
 * The renderer among the processes macOS holds the app responsible for: the
 * heaviest WebContent, not the first one. The app owns several (one per
 * out-of-process webview, plus the ones a browser pane opens), and the card's
 * 2337 MB was the main window's - the biggest.
 */
export function pickRenderer(rows: readonly ProcessRow[]): ProcessRow | null {
  const webContents = rows.filter((r) => r.name.includes(RENDERER_PROCESS_NAME));
  if (webContents.length === 0) return null;
  return webContents.reduce((big, r) => (r.footprintMB > big.footprintMB ? r : big));
}

/**
 * Slope in MB per minute over the SECOND HALF of the series.
 *
 * Boot allocates for a living: including it would report a climb for an app
 * that then sits still for hours, which is the wrong answer to "is it
 * growing?". Least squares rather than last-minus-first, because a single
 * sample taken while a page was decoding an image would otherwise decide it.
 */
export function slopeMBPerMin(series: readonly FootprintPoint[]): number {
  const s = series.slice(Math.floor(series.length / 2));
  if (s.length < 2) return 0;
  const n = s.length;
  const mx = s.reduce((a, c) => a + c.t, 0) / n;
  const my = s.reduce((a, c) => a + c.mb, 0) / n;
  let num = 0;
  let den = 0;
  for (const c of s) {
    num += (c.t - mx) * (c.mb - my);
    den += (c.t - mx) ** 2;
  }
  return den === 0 ? 0 : (num / den) * 60_000;
}

export interface GrowthVerdict {
  /** False means the bar is red: the series grows past the declared limit. */
  ok: boolean;
  slopeMBPerMin: number;
  firstMB: number;
  lastMB: number;
  /** One line, ready to print: what was measured and what it means. */
  reason: string;
}

/** Too few points to say anything: the series is not a verdict, it is noise. */
export const MIN_SAMPLES = 4;

/**
 * The bar itself. Deliberately one-sided: a footprint that SHRINKS is not a
 * failure, and a limit that also caught the descent would turn the garbage
 * collector doing its job into a red.
 */
export function judgeGrowth(series: readonly FootprintPoint[], maxMBPerMin: number): GrowthVerdict {
  const firstMB = series[0]?.mb ?? 0;
  const lastMB = series[series.length - 1]?.mb ?? 0;
  if (series.length < MIN_SAMPLES) {
    return {
      ok: true,
      slopeMBPerMin: 0,
      firstMB,
      lastMB,
      reason: `only ${series.length} samples (${MIN_SAMPLES} needed): nothing measured, nothing claimed`,
    };
  }
  const slope = slopeMBPerMin(series);
  const grew = slope > maxMBPerMin;
  return {
    ok: !grew,
    slopeMBPerMin: slope,
    firstMB,
    lastMB,
    reason: grew
      ? `GROWS: ${slope.toFixed(2)} MB/min over the limit of ${maxMBPerMin} MB/min ` +
        `(footprint ${firstMB.toFixed(0)} -> ${lastMB.toFixed(0)} MB). ` +
        `Next question is WHO: arm devHeapProbe, which counts live entities instead of weighing them.`
      : `FLAT: ${slope.toFixed(2)} MB/min, limit ${maxMBPerMin} MB/min ` +
        `(footprint ${firstMB.toFixed(0)} -> ${lastMB.toFixed(0)} MB)`,
  };
}
