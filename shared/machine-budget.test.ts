/**
 * THE CONTROLLER, DRIVEN BY HAND, because the machine cannot be asked to be at
 * load 155 on demand.
 *
 * Four questions, and they are the four the card asked for (363bbbc8): the
 * budget against what the others leave free, admission one at a time with
 * hysteresis, the order in which running work gets frozen, and the two samples
 * it takes to decide either way.
 *
 * The scenario at the bottom is the one that produced the card: eight cards in
 * Todo on a 12-core machine at an 80% budget. Before this module they all
 * started in one tick.
 *
 * @covers KANBAN-75
 */
import { describe, expect, test } from "bun:test";
import {
  ADMIT_RESUME_FRACTION,
  BUDGET_SHARE_DEFAULT,
  BUDGET_SHARE_MAX,
  BUDGET_SHARE_MIN,
  EMPTY_FREEZE_STATE,
  admissionVerdict,
  budgetShare,
  estimatedAgentCost,
  freezePlan,
  machineBudget,
  type FreezeState,
  type FreezeTarget,
  type MachineBudgetSample,
} from "./machine-budget";

const sample = (over: Partial<MachineBudgetSample> = {}): MachineBudgetSample => ({
  cores: 12,
  totalMemGB: 32,
  ourCoreUnits: 0,
  otherCoreUnits: 0,
  ourMemGB: 2,
  availableMemGB: 20,
  running: 1,
  ...over,
});

describe("the knob", () => {
  test("absent means the default, and the default is not the maximum", () => {
    expect(budgetShare({})).toBe(BUDGET_SHARE_DEFAULT);
    expect(BUDGET_SHARE_DEFAULT).toBeLessThan(BUDGET_SHARE_MAX);
  });

  test("a value out of range is clamped, never refused", () => {
    expect(budgetShare({ budgetShare: 5 })).toBe(BUDGET_SHARE_MAX);
    expect(budgetShare({ budgetShare: 0 })).toBe(BUDGET_SHARE_MIN);
    expect(budgetShare({ budgetShare: Number.NaN })).toBe(BUDGET_SHARE_DEFAULT);
  });
});

describe("budget against what the others leave", () => {
  test("80% of twelve cores is 9.6 core-units", () => {
    expect(machineBudget(sample(), 0.8).cpuCoreUnits).toBeCloseTo(9.6, 5);
  });

  test("usable is what the others leave free, when that is less than the budget", () => {
    // Somebody else is compiling: 8 of the 12 cores are theirs.
    const b = machineBudget(sample({ otherCoreUnits: 8 }), 0.8);
    expect(b.cpuCoreUnits).toBeCloseTo(9.6, 5);
    expect(b.usableCoreUnits).toBeCloseTo(4, 5);
  });

  test("not measured is not zero: an unmeasured machine leaves the budget alone", () => {
    const b = machineBudget(sample({ otherCoreUnits: null, availableMemGB: null }), 0.8);
    expect(b.usableCoreUnits).toBeCloseTo(9.6, 5);
    expect(b.usableMemGB).toBeCloseTo(b.memGB, 5);
  });

  test("the memory we already hold counts as reachable", () => {
    // 60% of 32 GB is 19.2; we hold 6 and 8 are free, so 14 is the real ceiling.
    const b = machineBudget(sample({ ourMemGB: 6, availableMemGB: 8 }), 0.6);
    expect(b.memGB).toBeCloseTo(19.2, 5);
    expect(b.usableMemGB).toBeCloseTo(14, 5);
  });
});

describe("the cost of one more agent", () => {
  test("no history prices it at the floor, never at zero", () => {
    expect(estimatedAgentCost([])).toBe(0.5);
  });

  test("it is the median, so one gate storm does not price every future agent", () => {
    expect(estimatedAgentCost([0.6, 0.7, 0.8, 0.9, 12])).toBeCloseTo(0.8, 5);
  });

  test("a pathological history cannot close the door for good", () => {
    expect(estimatedAgentCost([40, 50, 60])).toBe(4);
  });
});

describe("admission", () => {
  test("an idle fleet admits", () => {
    const v = admissionVerdict(sample({ ourCoreUnits: 0.2 }), 0.8, 1);
    expect(v.admit).toBe(true);
    expect(v.state).toBe("admitting");
    expect(v.blockedBy).toBe(null);
  });

  test("the cost of the NEXT agent is what closes the door, not the reading alone", () => {
    // 9.2 of 9.6 used: under the budget, but one more agent does not fit.
    const v = admissionVerdict(sample({ ourCoreUnits: 9.2 }), 0.8, 1);
    expect(v.admit).toBe(false);
    expect(v.blockedBy).toBe("cpu");
    expect(v.state).toBe("holding");
  });

  test("once holding, it resumes lower than where it stopped", () => {
    const budget = 9.6;
    const justUnder = budget - 1.1; // admits from `admitting`, still holds from `holding`
    expect(admissionVerdict(sample({ ourCoreUnits: justUnder }), 0.8, 1, "admitting").admit).toBe(true);
    expect(admissionVerdict(sample({ ourCoreUnits: justUnder }), 0.8, 1, "holding").admit).toBe(false);
    // It comes back at 80% of the budget, minus the cost of the one to admit.
    const back = budget * ADMIT_RESUME_FRACTION - 1.1;
    expect(admissionVerdict(sample({ ourCoreUnits: back }), 0.8, 1, "holding").admit).toBe(true);
  });

  test("with nothing in flight the first one starts anyway, and says so", () => {
    const v = admissionVerdict(sample({ ourCoreUnits: 20, running: 0 }), 0.8, 1);
    expect(v.admit).toBe(true);
    expect(v.firstAgentExempt).toBe(true);
    // The exemption is not a free machine: the state stays "holding".
    expect(v.state).toBe("holding");
  });

  test("memory blocks on its own axis", () => {
    const v = admissionVerdict(sample({ ourMemGB: 30, availableMemGB: 20 }), 0.5, 1);
    expect(v.admit).toBe(false);
    expect(v.blockedBy).toBe("memory");
  });

  test("what the others take shrinks what we may admit", () => {
    const busy = sample({ ourCoreUnits: 3, otherCoreUnits: 9 });
    // Budget 9.6, but only 3 core-units are actually free: 3 + 1 does not fit.
    expect(admissionVerdict(busy, 0.8, 1).admit).toBe(false);
    expect(admissionVerdict({ ...busy, otherCoreUnits: 0 }, 0.8, 1).admit).toBe(true);
  });
});

describe("freezing what is already running", () => {
  const checks = (n: number): FreezeTarget[] =>
    Array.from({ length: n }, (_, i) => ({ id: `check-${i}`, kind: "check" as const, startedAt: 1000 + i }));

  test("one sample over the budget freezes nothing", () => {
    const p = freezePlan({ used: 12, budget: 9.6, targets: checks(2) });
    expect(p.freeze).toBe(null);
    expect(p.state.overSamples).toBe(1);
  });

  test("two in a row freeze exactly one, the newest check", () => {
    let s: FreezeState = EMPTY_FREEZE_STATE;
    const targets = [...checks(2), { id: "agent-1", kind: "agent" as const, startedAt: 9999 }];
    s = freezePlan({ used: 12, budget: 9.6, targets }, s).state;
    const p = freezePlan({ used: 12, budget: 9.6, targets }, s);
    expect(p.freeze).toBe("check-1");
    expect(p.state.frozen).toEqual(["check-1"]);
  });

  test("checks before agents, however recent the agent is", () => {
    let s: FreezeState = EMPTY_FREEZE_STATE;
    const targets: FreezeTarget[] = [
      { id: "agent-late", kind: "agent", startedAt: 5000 },
      { id: "check-old", kind: "check", startedAt: 10 },
    ];
    const freeze = () => {
      s = freezePlan({ used: 20, budget: 9.6, targets }, s).state;
      const p = freezePlan({ used: 20, budget: 9.6, targets }, s);
      s = p.state;
      return p.freeze;
    };
    expect(freeze()).toBe("check-old");
    expect(freeze()).toBe("agent-late");
    // Nothing left to give up: it stops asking instead of looping.
    expect(freeze()).toBe(null);
  });

  test("thawing waits for two samples under 70% and undoes the last first", () => {
    const targets = checks(3);
    let s: FreezeState = { overSamples: 0, underSamples: 0, frozen: ["check-1", "check-2"] };
    const low = { used: 6, budget: 9.6, targets };
    expect(freezePlan(low, s).thaw).toBe(null);
    s = freezePlan(low, s).state;
    const p = freezePlan(low, s);
    expect(p.thaw).toBe("check-2");
    expect(p.state.frozen).toEqual(["check-1"]);
  });

  test("under the budget but over the thaw line, nothing moves", () => {
    const s: FreezeState = { overSamples: 0, underSamples: 1, frozen: ["check-0"] };
    // 8 of 9.6 is under the budget and over 70% of it: the dead band.
    const p = freezePlan({ used: 8, budget: 9.6, targets: checks(1) }, s);
    expect(p.freeze).toBe(null);
    expect(p.thaw).toBe(null);
    expect(p.state.underSamples).toBe(0);
  });

  test("a target that finished on its own leaves the list without a thaw", () => {
    const s: FreezeState = { overSamples: 0, underSamples: 0, frozen: ["check-gone", "check-0"] };
    const p = freezePlan({ used: 8, budget: 9.6, targets: checks(1) }, s);
    expect(p.state.frozen).toEqual(["check-0"]);
    expect(p.thaw).toBe(null);
  });
});

/**
 * THE EVENING OF 2026-09-07, replayed. Eight cards in Todo, 12 cores, budget at
 * 80% (9.6 core-units), an agent priced at 1.6 core-units by the median of the
 * last ones measured (an agent is cheap, its gates are not). What happened that
 * night: all eight started inside one tick, and ten minutes later the machine
 * was at load 155 with 13.4 GB of swap.
 */
test("the eight cards of the card do not start together any more", () => {
  const cores = 12;
  const share = 0.8;
  const cost = estimatedAgentCost([1.4, 1.6, 1.8]);
  let state: "admitting" | "holding" = "admitting";
  let running = 0;
  let ourCoreUnits = 0.4; // the server and the sidecars, before any agent
  let started = 0;

  // Ten ticks, and each tick may admit at most one card: the caller asks again
  // with a reading that includes what it just started.
  for (let tick = 0; tick < 10 && started < 8; tick++) {
    const v = admissionVerdict(
      { cores, totalMemGB: 32, ourCoreUnits, otherCoreUnits: 1, ourMemGB: 4, availableMemGB: 18, running },
      share,
      cost,
      state,
    );
    state = v.state;
    if (!v.admit) continue;
    started++;
    running++;
    // An agent that really works costs about what it was priced at.
    ourCoreUnits += cost;
  }

  // Five fit in the 9.6 core-units of the budget once the server's own share is
  // paid; the other three wait, and they wait one tick apart, not none.
  expect(started).toBe(5);
  expect(ourCoreUnits).toBeLessThanOrEqual(cores * share);
});
