/**
 * @covers GATE-05
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  judge,
  readMeasure,
  updatedBudget,
  type DragBaseline,
  type DragMeasure,
} from "./check-drag-frames";

/**
 * THE GATE, TESTED ON THE GATE.
 *
 * A gate nobody ever saw fail is not a gate: it passes, and keeps passing, and
 * nobody knows whether that is because everything is fine or because it stopped
 * looking. The real red, with a pointer really dragging and a main thread really
 * burned, comes from `TOPICS_DRAG_JANK_MS=12 bun run check:drag`. Below are the
 * cases that run cannot cover without a browser: each metric on its own, the
 * precedence of blockers over overruns, the never-recorded baseline, and the
 * stale measurement.
 *
 * The fixtures are synthetic ON PURPOSE. `judge`'s job is to decide, not to
 * measure: feeding it real numbers would make it verifiable only when a
 * Chromium is around, which is almost never.
 */

const BASELINE = JSON.parse(
  readFileSync(join(import.meta.dir, "drag-frames-baseline.json"), "utf8"),
) as DragBaseline;

/** The same baseline once a human has recorded it, which is the normal state. */
const RECORDED: DragBaseline = { ...BASELINE, recorded: true };

/**
 * And the state it ships in before anyone has run the bench. Derived, not read:
 * asserting `BASELINE.recorded === false` against the file on disk made the
 * suite fail the moment the baseline was actually recorded (2026-08-15), i.e.
 * doing the very thing the gate asks for broke its own test. What is worth
 * pinning is the RULE, and the rule needs a fixture.
 */
const UNRECORDED: DragBaseline = { ...BASELINE, recorded: false };

/**
 * A healthy measurement on a 120 Hz machine: every frame inside 60 FPS, no long
 * task, a drag that really travelled and really landed.
 */
const CLEAN: DragMeasure = {
  measured_at: "2026-08-15T10:00:00.000Z",
  jank_injected_ms: 0,
  calibration_gap_ms: 8.3,
  median: {
    p95_frame_ms: 9.1,
    worst_frame_ms: 24.4,
    longtask_count: 0,
    p50_frame_ms: 8.4,
    longtask_ms: 0,
    frames_over_16_7ms: 2,
  },
  witness: { frames: 62, pointer_moves: 60, drag_span_px: 1180, cards_rendered: 41, drops_committed: 3 },
};

interface Patch {
  measured_at?: string;
  calibration_gap_ms?: number;
  median?: Partial<DragMeasure["median"]>;
  witness?: Partial<DragMeasure["witness"]>;
}

const with_ = (patch: Patch): DragMeasure => ({
  ...CLEAN,
  ...patch,
  median: { ...CLEAN.median, ...(patch.median ?? {}) },
  witness: { ...CLEAN.witness, ...(patch.witness ?? {}) },
});

describe("judge", () => {
  it("is green on a healthy drag once the baseline has been recorded", () => {
    const o = judge(CLEAN, RECORDED);
    expect(o.code).toBe(0);
    expect(o.over).toEqual([]);
    expect(o.blockers).toEqual([]);
    expect(o.unrecorded).toBe(false);
  });

  it("prints all three metrics even when they are green", () => {
    // A table that shows up only on red forces a re-run to find out what the
    // healthy numbers were, which is how a budget stops being read.
    const o = judge(CLEAN, RECORDED);
    expect(o.rows).toHaveLength(3);
    expect(o.rows.join("\n")).toContain("p95 frame");
    expect(o.rows.join("\n")).toContain("worst frame");
    expect(o.rows.join("\n")).toContain("long tasks");
  });

  it("goes red on the p95 alone: the continuous lag behind the pointer", () => {
    // 26 ms per frame is 38 FPS with no single spike: the median and the worst
    // frame can both look fine while the drag visibly trails the hand.
    const o = judge(with_({ median: { p95_frame_ms: 26 } }), RECORDED);
    expect(o.code).toBe(1);
    expect(o.over).toHaveLength(1);
    expect(o.over[0]).toContain("p95_frame_ms");
  });

  it("goes red on the worst frame alone: the catch a percentile hides", () => {
    const o = judge(with_({ median: { worst_frame_ms: 210 } }), RECORDED);
    expect(o.code).toBe(1);
    expect(o.over[0]).toContain("worst_frame_ms");
  });

  it("goes red on the long tasks alone: the cause, not the symptom", () => {
    const o = judge(with_({ median: { longtask_count: 4 } }), RECORDED);
    expect(o.code).toBe(1);
    expect(o.over[0]).toContain("longtask_count");
  });

  it("calls a machine that delivers no frames NOT MEASURABLE, not a regression", () => {
    // 34 ms at rest on a BLANK page is the laptop, not the app. A gate that
    // reports this as a red gets switched off within a week.
    const o = judge(with_({ calibration_gap_ms: 34, median: { p95_frame_ms: 40 } }), RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("calibration");
  });

  it("a 60 Hz machine cannot be judged against a 60 FPS budget", () => {
    // The real CI case, 2026-08-15, the first run that ever reached this gate:
    // calibration 16.7 ms (a 60 Hz screen), p95 16.8 ms, red by 0.1 ms — one
    // cadence tick. The absolute ceiling did not notice because 16.7 is not > 20.
    // The budget is 16.7 ms, so on that machine the gate was asking the drag to
    // beat the display's own idle rate: no code passes that.
    const o = judge(with_({ calibration_gap_ms: 16.7, median: { p95_frame_ms: 16.8 } }), RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("at-rest cadence");
  });

  it("and a machine WITH room still gets judged, or the gate protects nothing", () => {
    // 8.3 ms at rest is the 120 Hz box the baseline came from: there the budget
    // has two ticks of headroom and a heavy drag must still come out red.
    const o = judge(with_({ calibration_gap_ms: 8.3, median: { p95_frame_ms: 25 } }), RECORDED);
    expect(o.code).toBe(1);
  });

  it("refuses a bench whose drop never landed, even with perfect frame times", () => {
    // Zero committed drops means the pointer waggled over a static board: the
    // best possible numbers, measured on no drag at all.
    const o = judge(with_({ witness: { drops_committed: 0 } }), RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("drops reached the server");
  });

  it("refuses an empty board: an empty board is fast for everybody", () => {
    const o = judge(with_({ witness: { cards_rendered: 3 } }), RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("cards");
  });

  it("treats a MISSING witness as an accusation, not as silence", () => {
    // The trap this is written against: with the field absent, `undefined <
    // floor` is false, so no blocker and a green exit. Renaming a field in the
    // spec would then switch the guard off silently and for good.
    const broken = { ...CLEAN, witness: { ...CLEAN.witness } } as unknown as DragMeasure;
    delete (broken.witness as Partial<DragMeasure["witness"]>).drops_committed;
    const o = judge(broken, RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("drops_committed");
  });

  it("puts blockers ahead of overruns", () => {
    const o = judge(
      with_({ calibration_gap_ms: 40, median: { p95_frame_ms: 90, longtask_count: 9 } }),
      RECORDED,
    );
    expect(o.code).toBe(2);
    expect(o.over.length).toBeGreaterThan(0);
    expect(o.blockers.length).toBeGreaterThan(0);
  });

  it("refuses a measurement older than the run", () => {
    const o = judge(CLEAN, RECORDED, new Date("2026-08-15T12:00:00.000Z"));
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("BEFORE this run");
  });

  it("refuses a measurement with no timestamp when freshness is required", () => {
    const noStamp = { ...CLEAN };
    delete noStamp.measured_at;
    const o = judge(noStamp, RECORDED, new Date("2026-08-15T09:00:00.000Z"));
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("measured_at");
  });

  it("exits 2 while the baseline has never been recorded, however good the numbers", () => {
    // A budget that has never seen a real number cannot tell "fine" from "the
    // bench measured nothing", so it must not be allowed to print green.
    const o = judge(CLEAN, UNRECORDED);
    expect(o.code).toBe(2);
    expect(o.unrecorded).toBe(true);
    expect(o.blockers).toEqual([]);
  });

  it("and judges normally once it HAS been recorded", () => {
    // The other half of the same rule, and the reason the case above uses a
    // fixture: the shipped baseline changes state the day someone runs the
    // bench, and a test bound to that state punishes them for it.
    const o = judge(CLEAN, RECORDED);
    expect(o.code).toBe(0);
    expect(o.unrecorded).toBeFalsy();
  });
});

describe("updatedBudget", () => {
  it("never writes a budget of zero out of a measurement of zero", () => {
    // Two of the three healthy values are expected to be at or near zero. A
    // budget of zero is a threshold no run can meet, and a gate nobody can meet
    // is a gate somebody deletes.
    const b = updatedBudget(with_({ median: { longtask_count: 0, worst_frame_ms: 0 } }), BASELINE);
    expect(b.longtask_count).toBeGreaterThan(0);
    expect(b.worst_frame_ms).toBeGreaterThan(0);
  });

  it("keeps the 60 FPS floor even on a very fast machine", () => {
    // 4.1 ms p95 on a 240 Hz screen times 1.5 is 6.15 ms, which would make the
    // gate red for anybody on 60 Hz hardware while the app is perfectly fine.
    const b = updatedBudget(with_({ median: { p95_frame_ms: 4.1 } }), BASELINE);
    expect(b.p95_frame_ms).toBe(16.7);
  });

  it("follows the measurement upwards when it is above the floor", () => {
    const b = updatedBudget(with_({ median: { p95_frame_ms: 20 } }), BASELINE);
    expect(b.p95_frame_ms).toBe(30);
  });
});

describe("readMeasure", () => {
  it("rejects valid JSON with the wrong shape", () => {
    const path = join(import.meta.dir, "drag-frames-baseline.json");
    // The baseline is valid JSON and is NOT a measurement: reading one as the
    // other has to fail loudly rather than judge whatever fields happen to match.
    expect(() => readMeasure(path)).toThrow(/shape of a measurement/);
  });
});
