/**
 * THE INTERACTION GATE, TESTED ON THE GATE.
 *
 * A gate nobody ever saw fail is not a gate: it passes, and keeps passing, and
 * nobody knows whether that is because everything is fine or because it stopped
 * looking. The real red, with a browser really answering, comes from the bench
 * itself. Below are the cases that run cannot cover without one: each exit on
 * its own, the precedence of the never-recorded baseline and of a measured
 * overrun, the stale file, the thin sample, and the log parsing that feeds the
 * shell source.
 *
 * The fixtures are synthetic ON PURPOSE. `judge` decides, it does not measure:
 * feeding it real numbers would make it verifiable only when a browser and a
 * desktop shell are around, which is almost never.
 *
 * @covers INTERACTION-01
 */
import { describe, expect, test } from "bun:test";
import {
  baselineRefusedReason,
  budgetFromP95,
  judge,
  parseSummaryLines,
  poolReports,
  roundUpTo8,
  type InteractionBaselineEntry,
  type InteractionReading,
} from "./check-inp-shell";

/** The same budget once a human has recorded it, which is the normal state. */
const RECORDED: InteractionBaselineEntry = {
  recorded: true,
  measuredOn: "2026-10-20",
  p95Ms: 40,
  budgetMs: 160,
};

/** And the state it ships in before anyone has measured. */
const FRESH: InteractionBaselineEntry = {
  recorded: false,
  measuredOn: null,
  p95Ms: null,
  budgetMs: null,
};

/** A healthy engine measurement: enough interactions, p95 inside the budget. */
const CLEAN_ENGINE: InteractionReading = {
  source: "engine",
  interactions: 64,
  slow: 6,
  p95Ms: 64,
  worstMs: 120,
  supported: true,
  stale: false,
  found: true,
};

interface Patch {
  source?: InteractionReading["source"];
  interactions?: number;
  slow?: number;
  p95Ms?: number | null;
  worstMs?: number;
  supported?: boolean;
  stale?: boolean;
  found?: boolean;
}

const withReading = (patch: Patch): InteractionReading => ({ ...CLEAN_ENGINE, ...patch });

describe("judge", () => {
  test("is green on a healthy reading once the baseline has been recorded", () => {
    const outcome = judge(CLEAN_ENGINE, RECORDED);
    expect(outcome.code).toBe(0);
    expect(outcome.over).toEqual([]);
    expect(outcome.blockers).toEqual([]);
    expect(outcome.unrecorded).toBe(false);
  });

  test("prints the whole table even when it is green", () => {
    // A table that shows up only on red forces a re-run to find out what the
    // healthy numbers were, which is how a budget stops being read.
    const outcome = judge(CLEAN_ENGINE, RECORDED);
    expect(outcome.rows).toHaveLength(5);
    const table = outcome.rows.join("\n");
    expect(table).toContain("source");
    expect(table).toContain("interactions");
    expect(table).toContain("slow");
    expect(table).toContain("p95");
    expect(table).toContain("budget");
    expect(table).toContain("worst");
  });

  test("exits 2 while the baseline was never recorded, however good the numbers", () => {
    const outcome = judge(CLEAN_ENGINE, FRESH);
    expect(outcome.code).toBe(2);
    expect(outcome.unrecorded).toBe(true);
  });

  test("the never-recorded baseline comes before anything else, even an overrun", () => {
    // A budget that has never seen a real number cannot tell "fine" from "the
    // bench measured nothing", so it must not print red on numbers it cannot judge.
    const outcome = judge(withReading({ p95Ms: 900, stale: true, supported: false }), FRESH);
    expect(outcome.code).toBe(2);
    expect(outcome.unrecorded).toBe(true);
    expect(outcome.over).toEqual([]);
  });

  test("a stale engine file is not measured, not a regression", () => {
    const outcome = judge(withReading({ stale: true }), RECORDED);
    expect(outcome.code).toBe(2);
    expect(outcome.blockers.join(" ")).toContain("older than the accepted window");
  });

  test("too few engine interactions are not measured", () => {
    const outcome = judge(withReading({ interactions: 19 }), RECORDED);
    expect(outcome.code).toBe(2);
    expect(outcome.blockers.join(" ")).toContain("below the minimum");
  });

  test("too few shell interactions are not measured, and two hundred are enough", () => {
    const thin = judge(
      { ...CLEAN_ENGINE, source: "shell", interactions: 199, p95Ms: 16 },
      RECORDED,
    );
    expect(thin.code).toBe(2);
    const enough = judge(
      { ...CLEAN_ENGINE, source: "shell", interactions: 200, p95Ms: 16 },
      RECORDED,
    );
    expect(enough.code).toBe(0);
  });

  test("supported:false is not measured", () => {
    const outcome = judge(withReading({ supported: false }), RECORDED);
    expect(outcome.code).toBe(2);
    expect(outcome.blockers.join(" ")).toContain("supported:false");
  });

  test("a missing p95 is not measured", () => {
    const outcome = judge(withReading({ p95Ms: null }), RECORDED);
    expect(outcome.code).toBe(2);
    expect(outcome.blockers.join(" ")).toContain("no p95");
  });

  test("a missing file is not measured", () => {
    const outcome = judge(withReading({ found: false, p95Ms: null, interactions: 0 }), RECORDED);
    expect(outcome.code).toBe(2);
    expect(outcome.blockers.join(" ")).toContain("no measurement was found");
  });

  test("goes red on a p95 over budget", () => {
    const outcome = judge(withReading({ p95Ms: 161 }), RECORDED);
    expect(outcome.code).toBe(1);
    expect(outcome.over.join(" ")).toContain("p95");
  });

  test("a measured overrun beats a stale file", () => {
    const outcome = judge(withReading({ p95Ms: 300, stale: true }), RECORDED);
    expect(outcome.code).toBe(1);
  });

  test("a measured overrun beats supported:false", () => {
    const outcome = judge(withReading({ p95Ms: 300, supported: false }), RECORDED);
    expect(outcome.code).toBe(1);
  });

  test("a measured overrun beats too few interactions", () => {
    const outcome = judge(withReading({ p95Ms: 300, interactions: 3 }), RECORDED);
    expect(outcome.code).toBe(1);
  });

  test("a measured overrun beats a missing file that still holds a number", () => {
    const outcome = judge(withReading({ p95Ms: 300, found: false }), RECORDED);
    expect(outcome.code).toBe(1);
  });
});

const lineFor = (when: string, client: string, fields: string): string =>
  `[client-trace] ${when} ${client} pane-attach inp-summary ${fields}`;

const fieldsFor = (
  shell: string,
  page: string,
  total: number,
  slow: number,
  worst: number,
  histogram: number[],
): string => JSON.stringify({ shell, pl: page, n: total, s: slow, w: worst, h: histogram });

const histogramWith = (pairs: Array<[number, number]>): number[] => {
  const histogram = new Array<number>(14).fill(0);
  for (const [index, count] of pairs) histogram[index] = count;
  return histogram;
};

describe("parseSummaryLines", () => {
  test("keeps only the last line per client and page load", () => {
    // Each page load reports CUMULATIVE totals several times: adding every
    // line would count the same interactions again with each report.
    const text = [
      lineFor("2026-10-20T10:00:00.000Z", "clientA", fieldsFor("tauri", "first", 10, 1, 40, histogramWith([]))),
      lineFor("2026-10-20T10:01:00.000Z", "clientA", fieldsFor("tauri", "first", 25, 3, 80, histogramWith([]))),
      lineFor("2026-10-20T10:02:00.000Z", "clientA", fieldsFor("tauri", "second", 7, 0, 20, histogramWith([]))),
    ].join("\n");
    const reports = parseSummaryLines(text, Date.parse("2026-10-20T00:00:00.000Z"));
    expect(reports).toHaveLength(2);
    expect(reports[0]?.total).toBe(25);
    expect(reports[0]?.worst).toBe(80);
    expect(reports[1]?.pageLoad).toBe("second");
  });

  test("the same page load on two clients counts twice", () => {
    const text = [
      lineFor("2026-10-20T10:00:00.000Z", "clientA", fieldsFor("tauri", "shared", 10, 1, 40, histogramWith([]))),
      lineFor("2026-10-20T10:01:00.000Z", "clientB", fieldsFor("tauri", "shared", 12, 2, 48, histogramWith([]))),
    ].join("\n");
    expect(parseSummaryLines(text, 0)).toHaveLength(2);
  });

  test("skips a cut JSON instead of crashing", () => {
    // Fields are cut at 600 chars by the server: the line ends mid-object and
    // the parse fails. That line is evidence of a cut, not of a measurement.
    const text = [
      "[client-trace] 2026-10-20T10:00:00.000Z clientA pane-attach inp-summary {\"shell\":\"tauri\",\"pl\":\"cut\",\"n\":50,",
      "[client-trace] 2026-10-20T10:00:00.000Z clientA pane-attach inp-summary {\"shell\":\"tauri\",\"pl\":\"cut...\"",
      lineFor("2026-10-20T10:01:00.000Z", "clientA", fieldsFor("tauri", "whole", 30, 2, 64, histogramWith([]))),
    ].join("\n");
    const reports = parseSummaryLines(text, 0);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.pageLoad).toBe("whole");
  });

  test("skips lines from another shell", () => {
    const text = [
      lineFor("2026-10-20T10:00:00.000Z", "clientA", fieldsFor("web", "first", 500, 50, 300, histogramWith([]))),
      lineFor("2026-10-20T10:01:00.000Z", "clientA", fieldsFor("tauri", "first", 30, 2, 64, histogramWith([]))),
    ].join("\n");
    const reports = parseSummaryLines(text, 0);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.shell).toBe("tauri");
  });

  test("honours the day window", () => {
    const text = [
      lineFor("2026-10-10T10:00:00.000Z", "clientA", fieldsFor("tauri", "old", 400, 40, 200, histogramWith([]))),
      lineFor("2026-10-20T10:00:00.000Z", "clientA", fieldsFor("tauri", "fresh", 30, 2, 64, histogramWith([]))),
    ].join("\n");
    const reports = parseSummaryLines(text, Date.parse("2026-10-19T00:00:00.000Z"));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.pageLoad).toBe("fresh");
  });

  test("ignores lines that carry no summary", () => {
    const text = [
      "[client-trace] 2026-10-20T10:00:00.000Z clientA pane-attach opened {}",
      "server booted in 120 ms",
      "",
    ].join("\n");
    expect(parseSummaryLines(text, 0)).toEqual([]);
  });
});

describe("poolReports", () => {
  test("pools several page loads into one total, one worst, one p95", () => {
    const reports = parseSummaryLines(
      [
        lineFor("2026-10-20T10:00:00.000Z", "clientA", fieldsFor("tauri", "one", 100, 5, 96, histogramWith([[0, 5]]))),
        lineFor("2026-10-20T10:01:00.000Z", "clientB", fieldsFor("tauri", "two", 100, 3, 128, histogramWith([[0, 3]]))),
      ].join("\n"),
      0,
    );
    const pooled = poolReports(reports);
    expect(pooled.total).toBe(200);
    expect(pooled.slow).toBe(8);
    expect(pooled.worst).toBe(128);
    // 8 slow of 200: the 5 percent slowest are fewer than the slow ones, so
    // the p95 sits below what the reporter thresholds, at 16 ms.
    expect(pooled.p95Ms).toBe(16);
  });

  test("a slow crowd moves the pooled p95 into its bucket", () => {
    const reports = parseSummaryLines(
      [
        lineFor("2026-10-20T10:00:00.000Z", "clientA", fieldsFor("tauri", "one", 100, 100, 80, histogramWith([[4, 100]]))),
        lineFor("2026-10-20T10:01:00.000Z", "clientB", fieldsFor("tauri", "two", 100, 100, 90, histogramWith([[4, 100]]))),
      ].join("\n"),
      0,
    );
    const pooled = poolReports(reports);
    expect(pooled.total).toBe(200);
    // Every interaction sits in the bucket that starts at 48 ms, so the first
    // bucket from the top that holds the slowest 5 percent answers 64 ms.
    expect(pooled.p95Ms).toBe(64);
  });
});

describe("roundUpTo8 and budgetFromP95", () => {
  test("rounds up to the next multiple of 8", () => {
    expect(roundUpTo8(40)).toBe(40);
    expect(roundUpTo8(41)).toBe(48);
    expect(roundUpTo8(52)).toBe(56);
    expect(roundUpTo8(0)).toBe(0);
  });

  test("the budget is four times the measured p95, rounded up to 8", () => {
    expect(budgetFromP95(30)).toBe(120);
    expect(budgetFromP95(13)).toBe(56);
  });

  test("the floor keeps a fast machine from writing an unmeetable budget", () => {
    expect(budgetFromP95(10)).toBe(48);
    expect(budgetFromP95(0)).toBe(48);
  });

  test("the cap never passes the good ceiling", () => {
    expect(budgetFromP95(60)).toBe(200);
    expect(budgetFromP95(100)).toBe(200);
  });
});

describe("baselineRefusedReason", () => {
  test("refuses a first measurement that is already above the good ceiling", () => {
    // When the gate is born on a slow product it is born red on purpose: a
    // recorded budget above 200 would bless the problem as normal.
    const reason = baselineRefusedReason(208);
    expect(reason).not.toBeNull();
    expect(reason as string).toContain("born red");
  });

  test("allows a measurement at or below the ceiling", () => {
    expect(baselineRefusedReason(200)).toBeNull();
    expect(baselineRefusedReason(64)).toBeNull();
  });
});
