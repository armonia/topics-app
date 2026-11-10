#!/usr/bin/env bun
/**
 * scripts/e2e-duration-regressions.ts - which spec files got MEANINGFULLY
 * slower overnight, compared to the durations recorded the night before.
 *
 * WHY IT EXISTS. `scripts/e2e-record-durations.ts` measures every spec file's
 * duration, every night, to feed `e2e-plan-shards.ts` - but a measurement kept
 * only for load-balancing is a number nobody reads twice. A spec that keeps
 * getting slower, night after night, is a real signal (a leak, a growing
 * fixture, a wait that should have been an event) and it stays invisible until
 * it crosses a timeout and turns red - at which point the question "since when"
 * has no answer, because nothing kept the trend.
 *
 * WHAT COUNTS AS A REGRESSION, and why both thresholds. A file that grows from
 * 0.3s to 0.6s doubled, which is a scary percentage over nothing: the absolute
 * floor (`MIN_ABSOLUTE_GROWTH_S`) keeps noise out. A file that grows from 120s
 * to 126s crossed the absolute floor on a 5% wobble that any shared CI runner
 * produces: the percentage floor (`MIN_RELATIVE_GROWTH`) keeps that out too.
 * Both have to hold.
 *
 * A file missing from one of the two snapshots is NOT a regression: new specs
 * have nothing to regress FROM, and a removed spec has nothing to regress INTO.
 *
 * USAGE
 *   bun run scripts/e2e-duration-regressions.ts <before.json> <after.json>
 * Exits 0 always: this informs, like e2e-failed-titles.ts, it does not gate.
 */

export interface Regression {
  file: string;
  beforeS: number;
  afterS: number;
  growthPct: number;
}

const MIN_ABSOLUTE_GROWTH_S = 5;
const MIN_RELATIVE_GROWTH = 0.2; // 20%
const MAX_LINES = 20;

/**
 * Compares two `e2e-durations.json` snapshots (file -> seconds) and returns
 * the files that got slower by both a relative and an absolute margin, slowest
 * growth first.
 */
export function findRegressions(
  before: Record<string, number>,
  after: Record<string, number>,
): Regression[] {
  const out: Regression[] = [];
  for (const [file, afterS] of Object.entries(after)) {
    const beforeS = before[file];
    if (beforeS === undefined || beforeS <= 0) continue;
    const growth = afterS - beforeS;
    if (growth < MIN_ABSOLUTE_GROWTH_S) continue;
    const growthPct = growth / beforeS;
    if (growthPct < MIN_RELATIVE_GROWTH) continue;
    out.push({ file, beforeS, afterS, growthPct });
  }
  return out.sort((a, b) => b.growthPct - a.growthPct);
}

function formatLine(r: Regression): string {
  const pct = Math.round(r.growthPct * 100);
  return `${r.file}: ${r.beforeS}s -> ${r.afterS}s (+${pct}%)`;
}

if (import.meta.main) {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error(
      "usage: bun run scripts/e2e-duration-regressions.ts <before.json> <after.json>",
    );
    process.exit(2);
  }
  let before: Record<string, number> = {};
  let after: Record<string, number> = {};
  try {
    before = JSON.parse(await Bun.file(beforePath).text());
  } catch {
    console.log("(no previous durations snapshot: nothing to compare)");
    process.exit(0);
  }
  try {
    after = JSON.parse(await Bun.file(afterPath).text());
  } catch {
    console.log("(no fresh durations snapshot: nothing to compare)");
    process.exit(0);
  }

  const regressions = findRegressions(before, after);
  if (regressions.length === 0) {
    console.log("(no spec file got meaningfully slower overnight)");
    process.exit(0);
  }
  for (const r of regressions.slice(0, MAX_LINES)) console.log(formatLine(r));
  if (regressions.length > MAX_LINES) {
    console.log(`... and ${regressions.length - MAX_LINES} more`);
  }
}
