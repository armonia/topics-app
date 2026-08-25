import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  judge,
  readMeasure,
  updatedBudget,
  type GrowthBaseline,
  type GrowthMeasure,
} from "./check-session-growth";

/**
 * THE GATE, TESTED ON THE GATE.
 *
 * The real red, with a leak really injected into a real page, comes from
 * `TOPICS_GROWTH_LEAK_NODES=120 bun run check:growth`. Below are the cases that
 * run cannot cover without a browser: each ratio on its own, the precedence of
 * blockers over overruns, the two halves of the fraction that can lie
 * independently, the never-recorded baseline, and the stale measurement.
 *
 * The fixtures are synthetic ON PURPOSE. `judge`'s job is to decide, not to
 * measure.
 *
 * @covers LEAK-01
 */

const BASELINE = JSON.parse(
  readFileSync(join(import.meta.dir, "session-growth-baseline.json"), "utf8"),
) as GrowthBaseline;

/** The same baseline once a human has recorded it, which is the normal state. */
const RECORDED: GrowthBaseline = { ...BASELINE, recorded: true };

/**
 * And the state it ships in before anyone has run the bench. Derived, not read:
 * its sibling gate asserted `BASELINE.recorded === false` against the file on
 * disk, and the day the baseline was actually recorded (2026-08-15) that
 * assertion failed, i.e. doing the very thing the gate asks for broke its own
 * test. What is worth pinning is the RULE, and the rule needs a fixture.
 */
const UNRECORDED: GrowthBaseline = { ...BASELINE, recorded: false };

/** A flat session: fifty cycles, heap barely moved, DOM and listeners unchanged. */
const FLAT: GrowthMeasure = {
  measured_at: "2026-08-15T10:00:00.000Z",
  leak_injected_nodes: 0,
  protocol: { cycles: 50, baseline_cycle: 5, final_cycle: 50 },
  ratio: { heap: 1.06, dom_nodes: 1.0, listeners: 1.0, retained_nodes: 1.01 },
  witness: {
    cycles_completed: 50,
    panes_reopened: 50,
    messages_streamed: 100,
    gc_forced: true,
    first: { cycle: 5, heap_bytes: 48_000_000, dom_nodes: 2_140, listeners: 610 },
    last: { cycle: 50, heap_bytes: 50_900_000, dom_nodes: 2_140, listeners: 610 },
  },
};

interface Patch {
  measured_at?: string;
  ratio?: Partial<GrowthMeasure["ratio"]>;
  witness?: Partial<GrowthMeasure["witness"]>;
}

const with_ = (patch: Patch): GrowthMeasure => ({
  ...FLAT,
  ...patch,
  ratio: { ...FLAT.ratio, ...(patch.ratio ?? {}) },
  witness: { ...FLAT.witness, ...(patch.witness ?? {}) },
});

describe("judge", () => {
  it("is green on a flat session once the baseline has been recorded", () => {
    const o = judge(FLAT, RECORDED);
    expect(o.code).toBe(0);
    expect(o.over).toEqual([]);
    expect(o.blockers).toEqual([]);
  });

  it("prints all three ratios even when they are green", () => {
    const o = judge(FLAT, RECORDED);
    expect(o.rows).toHaveLength(3);
    expect(o.rows.join("\n")).toContain("heap");
    expect(o.rows.join("\n")).toContain("DOM nodes");
    expect(o.rows.join("\n")).toContain("listeners");
  });

  it("goes red on the heap alone: a store that appends and never trims", () => {
    const o = judge(with_({ ratio: { heap: 2.4 } }), RECORDED);
    expect(o.code).toBe(1);
    expect(o.over).toHaveLength(1);
    expect(o.over[0]).toContain("heap");
  });

  it("goes red on DOM nodes alone: a subtree that outlived its owner", () => {
    // The shape the injected leak produces, and the one a pane that does not
    // unmount cleanly produces too: the heap can stay flat if the nodes are small.
    const o = judge(with_({ ratio: { dom_nodes: 1.4 } }), RECORDED);
    expect(o.code).toBe(1);
    expect(o.over[0]).toContain("dom_nodes");
  });

  it("goes red on listeners alone: the effect whose cleanup stopped running", () => {
    const o = judge(with_({ ratio: { listeners: 1.22 } }), RECORDED);
    expect(o.code).toBe(1);
    expect(o.over[0]).toContain("listeners");
  });

  it("refuses a run too short to say anything about a long session", () => {
    // Five cycles are flat by default. A gate that reports this as green is
    // worse than no gate: it certifies the thing it never looked at.
    const o = judge(
      with_({ witness: { cycles_completed: 6, panes_reopened: 6, messages_streamed: 12 } }),
      RECORDED,
    );
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("cycles completed");
  });

  it("refuses a run where the pane never actually reopened", () => {
    // The half of the cycle where leaks live. Everything else can have happened.
    const o = judge(with_({ witness: { panes_reopened: 0 } }), RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("panes reopened");
  });

  it("refuses a measurement taken without forcing a collection", () => {
    const o = judge(with_({ witness: { gc_forced: false } }), RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("collection was never forced");
  });

  it("refuses a denominator too small for a ratio", () => {
    // 400 KB of heap at cycle 5 means the page had not loaded. Every later
    // sample then divides by noise, and the ratio is a random number.
    const o = judge(
      with_({ witness: { first: { cycle: 5, heap_bytes: 400_000, dom_nodes: 2_140, listeners: 610 } } }),
      RECORDED,
    );
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("bytes");
  });

  it("treats a MISSING witness as an accusation, not as silence", () => {
    const broken = { ...FLAT, witness: { ...FLAT.witness } } as unknown as GrowthMeasure;
    delete (broken.witness as Partial<GrowthMeasure["witness"]>).cycles_completed;
    const o = judge(broken, RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("cycles_completed");
  });

  it("treats a ratio that is not a number as a broken bench, not a flat app", () => {
    const broken = { ...FLAT, ratio: { ...FLAT.ratio } } as unknown as GrowthMeasure;
    delete (broken.ratio as Partial<GrowthMeasure["ratio"]>).listeners;
    const o = judge(broken, RECORDED);
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("listeners");
  });

  it("puts blockers ahead of overruns", () => {
    const o = judge(
      with_({ witness: { gc_forced: false }, ratio: { heap: 9, dom_nodes: 4, listeners: 4 } }),
      RECORDED,
    );
    expect(o.code).toBe(2);
    expect(o.over.length).toBeGreaterThan(0);
    expect(o.blockers.length).toBeGreaterThan(0);
  });

  it("refuses a measurement older than the run", () => {
    const o = judge(FLAT, RECORDED, new Date("2026-08-15T12:00:00.000Z"));
    expect(o.code).toBe(2);
    expect(o.blockers.join(" ")).toContain("BEFORE this run");
  });

  it("exits 2 while the baseline has never been recorded, however flat the numbers", () => {
    const o = judge(FLAT, UNRECORDED);
    expect(o.code).toBe(2);
    expect(o.unrecorded).toBe(true);
    expect(o.blockers).toEqual([]);
  });

  it("and judges normally once it HAS been recorded", () => {
    const o = judge(FLAT, RECORDED);
    expect(o.code).toBe(0);
    expect(o.unrecorded).toBeFalsy();
  });
});

describe("updatedBudget", () => {
  it("adds the margin instead of multiplying it", () => {
    // A ratio near one multiplied by two is not a budget: 1.02 x 2 = 2.04 would
    // let a session double its heap every fifty cycles and still pass.
    const b = updatedBudget(with_({ ratio: { dom_nodes: 1.02 } }), BASELINE);
    expect(b.dom_nodes).toBeLessThan(1.2);
  });

  it("never writes 1.00 out of a perfectly flat measurement", () => {
    // A budget of exactly 1.00 makes ordinary run-to-run noise a red, and a gate
    // that cries for nothing gets switched off.
    const b = updatedBudget(with_({ ratio: { heap: 1, dom_nodes: 1, listeners: 1 } }), BASELINE);
    expect(b.heap).toBeGreaterThan(1);
    expect(b.dom_nodes).toBeGreaterThan(1);
    expect(b.listeners).toBeGreaterThan(1);
  });

  it("follows the measurement upwards when it is above the floor", () => {
    const b = updatedBudget(with_({ ratio: { heap: 1.4 } }), BASELINE);
    expect(b.heap).toBe(1.55);
  });
});

describe("readMeasure", () => {
  it("rejects valid JSON with the wrong shape", () => {
    const path = join(import.meta.dir, "session-growth-baseline.json");
    expect(() => readMeasure(path)).toThrow(/shape of a measurement/);
  });
});
