import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReport,
  compareStall,
  readCurtainMs,
  readInkBaseline,
  readMeasure,
  type BenchMeasure,
  type InkBaseline,
} from "./latency";

/**
 * THE REPORT, TESTED ON THE REPORT.
 *
 * A report that has only ever been seen printing numbers proves nothing about
 * what it does when the numbers are missing, stale, or impossible. The real
 * falsification — a genuinely slow app, and every row moving because of it —
 * comes from `bun run scripts/bench/latency.ts --stall 120`. Below are the cases
 * that run cannot cover without a browser: each blocker on its own, the
 * precedence of "not measurable" over everything else, the composition of the
 * cold open, and the rule that the ink gestures are READ and never re-measured.
 *
 * The fixtures are synthetic ON PURPOSE. `buildReport`'s job is to decide what
 * can be published, not to measure: feeding it real numbers would make it
 * verifiable only when a Chromium is around, which is almost never.
 */

const REPO_ROOT = join(import.meta.dir, "../..");

const INK: InkBaseline = {
  measuredOn: "2026-08-14",
  how: "5 samples per gesture, headless Chromium 1280x800",
  card: { medianMs: 23.5, spreadMs: "23.3-23.9", what: "open a card" },
  tab: { medianMs: 14.6, spreadMs: "13.7-14.9", what: "switch tab" },
  send: { medianMs: 12.4, spreadMs: "10.2-15.7", what: "send a message" },
};

const CLEAN: BenchMeasure = {
  measured_at: "2026-08-15T10:00:00.000Z",
  stall_ms: 0,
  samples_per_gesture: 5,
  board_samples_per_volume: 3,
  machine: {
    platform: "darwin",
    arch: "arm64",
    cpus: 12,
    cpu_model: "Apple M-series",
    memory_gb: 36,
    browser: "chromium 142",
    viewport: "1600x900, headless",
  },
  gestures: {
    boot_first_frame: g("app boot → first frame", [84, 86, 88], 86, 84, 88),
    boot_interactive: g("app boot → sidebar usable", [118.6, 119.2, 119.7], 119.2, 118.6, 119.7),
    topic_open_cold: g("open a topic, COLD", [389.2, 393.5, 397.8], 393.5, 389.2, 397.8),
    board_paint_50: g("board 50", [420.1, 427.7, 430], 427.7, 420.1, 430),
    board_paint_500: g("board 500", [980, 1010, 1040], 1010, 980, 1040),
    board_paint_200: g("board 200", [600, 610, 620], 610, 600, 620),
  },
  witness: {
    board_cards_rendered_50: 50,
    board_cards_rendered_200: 200,
    board_cards_rendered_500: 500,
  },
};

function g(
  label: string,
  samples: number[],
  medianMs: number,
  minMs: number,
  maxMs: number,
): BenchMeasure["gestures"][string] {
  return { label, metric: "test fixture", samples, medianMs, minMs, maxMs };
}

const base = { measure: CLEAN, ink: INK, curtainMs: 320 };

describe("buildReport", () => {
  it("publishes every gesture on a healthy measurement", () => {
    const r = buildReport(base);
    expect(r.code).toBe(0);
    expect(r.blockers).toEqual([]);
    expect(r.untrustworthy).toEqual([]);
    // Four measured here (boot ×2, cold open, three board volumes) plus the four
    // read from the ink budget.
    expect(r.rows).toHaveLength(10);
  });

  it("marks the ink gestures as READ, never as measured here", () => {
    // The rule this whole file exists to protect: a second measurement of a
    // gesture somebody else already publishes is how one number ends up with two
    // values. If these rows ever say "measured here", that rule was broken.
    const r = buildReport(base);
    const inkRows = r.rows.filter((row) => row.source.includes("ink-budget.json"));
    expect(inkRows).toHaveLength(4);
    for (const row of inkRows) expect(row.source).not.toContain("measured here");
    expect(inkRows.map((row) => row.medianMs).sort((a, b) => a - b)).toEqual([12.4, 14.6, 14.6, 23.5]);
  });

  it("says that the warm open and the topic switch are the SAME gesture", () => {
    // Two rows, one measurement. Left unsaid, the table reads as if the app had
    // been measured twice and happened to agree to the decimal.
    const r = buildReport(base);
    const twins = r.rows.filter((row) => row.medianMs === INK.tab.medianMs);
    expect(twins).toHaveLength(2);
    expect(twins.some((row) => (row.note ?? "").includes("same"))).toBe(true);
  });

  it("writes what the cold open is MADE of, not just how long it is", () => {
    const r = buildReport(base);
    const cold = r.rows.find((row) => row.gesture.includes("COLD"));
    expect(cold?.note).toContain("320");
    expect(cold?.note).toContain("LIST_REVEAL_FLOOR_MS");
    // 393.5 - 320: the app's own work, which is the only part a change could move.
    expect(cold?.note).toContain("73.5");
  });

  it("admits it when the curtain constant cannot be found", () => {
    // Silently dropping the composition would leave 393 ms looking like 393 ms of
    // work, which is the one reading of this number that is wrong.
    const r = buildReport({ ...base, curtainMs: null });
    const cold = r.rows.find((row) => row.gesture.includes("COLD"));
    expect(cold?.note).toContain("LIST_REVEAL_FLOOR_MS was not found");
  });

  it("orders the board volumes by size and not by string", () => {
    const volumes = buildReport(base)
      .rows.filter((row) => row.gesture.startsWith("board painted"))
      .map((row) => row.gesture);
    expect(volumes).toEqual([
      "board painted, 50 cards",
      "board painted, 200 cards",
      "board painted, 500 cards",
    ]);
  });

  it("says how many cards really reached the DOM next to each board number", () => {
    // A board that drew 25 of 500 cards is a fast board that measured nothing.
    const row = buildReport(base).rows.find((r) => r.gesture === "board painted, 500 cards");
    expect(row?.note).toContain("500 cards really in the DOM");
    // And that the number contains the boot, which is the other way this row
    // gets misread: 1010 ms is not what drawing 500 cards costs.
    expect(row?.note).toContain("119.2 ms of shell boot");
  });

  it("reports NOT MEASURABLE, not a report with holes, when there is no measurement", () => {
    const r = buildReport({ ...base, measure: null });
    expect(r.code).toBe(2);
    expect(r.rows).toEqual([]);
    expect(r.blockers.join(" ")).toContain("no measurement");
  });

  it("reports NOT MEASURABLE when the ink baseline is missing", () => {
    // Half a table would publish boot times next to nothing, and the missing
    // half is exactly the part that says the app is fast once it is up.
    const r = buildReport({ ...base, ink: null });
    expect(r.code).toBe(2);
    expect(r.blockers.join(" ")).toContain("ink baseline");
  });

  it("refuses a measurement taken BEFORE this run", () => {
    const r = buildReport({ ...base, freshAfter: new Date("2026-08-15T12:00:00.000Z") });
    expect(r.code).toBe(2);
    expect(r.blockers.join(" ")).toContain("BEFORE this run");
  });

  it("refuses a measurement with no timestamp when freshness is required", () => {
    const noStamp = { ...CLEAN };
    delete noStamp.measured_at;
    const r = buildReport({ ...base, measure: noStamp, freshAfter: new Date("2026-08-15T09:00:00.000Z") });
    expect(r.code).toBe(2);
    expect(r.blockers.join(" ")).toContain("measured_at");
  });

  it("accepts a measurement taken after the run started", () => {
    const r = buildReport({ ...base, freshAfter: new Date("2026-08-15T09:00:00.000Z") });
    expect(r.code).toBe(0);
  });

  it("calls a zero a lie rather than a very fast app", () => {
    const broken: BenchMeasure = {
      ...CLEAN,
      gestures: { ...CLEAN.gestures, boot_first_frame: g("boot", [0], 0, 0, 0) },
    };
    const r = buildReport({ ...base, measure: broken });
    expect(r.code).toBe(1);
    expect(r.untrustworthy.join(" ")).toContain("cannot take zero");
  });

  it("treats a MISSING gesture as an accusation, not as silence", () => {
    // The trap: with the key absent, an `if (g)` guard would skip the row and the
    // report would print a shorter, perfectly green table for ever.
    const gestures = { ...CLEAN.gestures };
    delete gestures.boot_interactive;
    const r = buildReport({ ...base, measure: { ...CLEAN, gestures } });
    expect(r.code).toBe(1);
    expect(r.untrustworthy.join(" ")).toContain("not measured at all");
  });

  it("says out loud when the numbers came from a deliberately slowed run", () => {
    // The one way this report could mislead: publishing the falsification run.
    const r = buildReport({ ...base, measure: { ...CLEAN, stall_ms: 120 } });
    expect(r.notes.join(" ")).toContain("DELIBERATELY SLOW");
  });

  it("prints the machine, because a boot time without one is a number about nothing", () => {
    expect(buildReport(base).notes.join(" ")).toContain("Apple M-series");
  });
});

describe("compareStall", () => {
  const stalled: BenchMeasure = {
    ...CLEAN,
    stall_ms: 120,
    gestures: {
      ...CLEAN.gestures,
      boot_first_frame: g("boot", [200], 200, 200, 200),
      boot_interactive: g("interactive", [300], 300, 300, 300),
      topic_open_cold: g("cold", [560], 560, 560, 560),
      board_paint_50: g("board 50", [700], 700, 700, 700),
      board_paint_200: g("board 200", [900], 900, 900, 900),
      board_paint_500: g("board 500", [1400], 1400, 1400, 1400),
    },
  };

  it("is green when every gesture noticed the injected defect", () => {
    const v = compareStall(CLEAN, stalled, 120);
    expect(v.code).toBe(0);
    expect(v.deaf).toEqual([]);
    expect(v.rows).toHaveLength(6);
  });

  it("goes red on the ONE gesture that did not move", () => {
    // The failure this check exists for: a probe wired to something that is
    // already painted reports the same number however slow the app is.
    const deafOne: BenchMeasure = {
      ...stalled,
      gestures: { ...stalled.gestures, boot_first_frame: g("boot", [88], 88, 88, 88) },
    };
    const v = compareStall(CLEAN, deafOne, 120);
    expect(v.code).toBe(1);
    expect(v.deaf).toHaveLength(1);
    expect(v.deaf[0]).toContain("boot_first_frame");
  });

  it("refuses to compare against a reference that was itself stalled", () => {
    const v = compareStall({ ...CLEAN, stall_ms: 40 }, stalled, 120);
    expect(v.code).toBe(2);
    expect(v.blockers.join(" ")).toContain("itself taken with a 40 ms stall");
  });

  it("refuses a stalled run that did not carry the stall it was asked for", () => {
    // The env var not reaching the spec is silent otherwise: the two runs would
    // be identical and the check would report the bench as deaf, accusing the
    // probes for a mistake made on the command line.
    const v = compareStall(CLEAN, { ...stalled, stall_ms: 0 }, 120);
    expect(v.code).toBe(2);
    expect(v.blockers.join(" ")).toContain("not the run that was asked for");
  });

  it("names a gesture that vanished from the stalled run instead of skipping it", () => {
    const gestures = { ...stalled.gestures };
    delete gestures.topic_open_cold;
    const v = compareStall(CLEAN, { ...stalled, gestures }, 120);
    expect(v.code).toBe(1);
    expect(v.deaf.join(" ")).toContain("topic_open_cold");
  });
});

describe("readCurtainMs", () => {
  it("finds the constant in the source", () => {
    expect(readCurtainMs("  const LIST_REVEAL_FLOOR_MS = 320;")).toBe(320);
  });

  it("returns null rather than a guess when the constant is gone", () => {
    expect(readCurtainMs("const SOMETHING_ELSE = 320;")).toBeNull();
  });

  it("still finds it in the file that actually holds it", () => {
    // Bound to the LIVE source on purpose. If the constant is renamed, the report
    // stops being able to say what the cold open is made of, and that silence is
    // worth a red here rather than a note nobody reads in a table.
    const source = readFileSync(
      join(REPO_ROOT, "client/src/components/Chat/MessageList.tsx"),
      "utf8",
    );
    expect(readCurtainMs(source)).toBeGreaterThan(0);
  });
});

describe("readMeasure", () => {
  it("rejects valid JSON with the wrong shape", () => {
    // The budget file is valid JSON and is NOT a measurement: reading one as the
    // other has to fail loudly rather than report whatever fields line up.
    expect(() => readMeasure(join(REPO_ROOT, "tests/e2e/ink-budget.json"))).toThrow(
      /shape of a bench-latency measurement/,
    );
  });
});

describe("readInkBaseline", () => {
  it("reads the three published gestures from the budget file", () => {
    const ink = readInkBaseline(join(REPO_ROOT, "tests/e2e/ink-budget.json"));
    expect(ink.card.medianMs).toBeGreaterThan(0);
    expect(ink.tab.medianMs).toBeGreaterThan(0);
    expect(ink.send.medianMs).toBeGreaterThan(0);
    expect(ink.measuredOn).not.toBe("unknown date");
  });
});
