/**
 * THE READING BEHIND THE RING. Three states have to be told apart without a
 * browser: under the ceiling, at it, past it. Plus the two that are not a load
 * at all — the probe has not answered, and there is no ceiling — because both
 * would otherwise be drawn as "empty ring, all good", which is a lie in the
 * first case.
 *
 * @covers KANBAN-79
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { admissionVerdictText, cpuPercent, dispatchLoadReading, gateCoreNumbers, limitDerivation, loadAdvice, loadToneClass, loadWordKey, memPercent } from './dispatchLoad';
import type { GlobalDispatchCapState } from '../../state/globalDispatchCap';
import type { DispatchAdmission, DispatchCapacity } from '../../lib/board';
import { admissionVerdict } from '../../../../shared/machine-budget';
import { CHECKS_MEM_FLOOR_DEFAULT_GB } from '../../lib/board';

const machine = (over: Partial<DispatchCapacity> = {}): DispatchCapacity => ({
  recommended: 4,
  cores: 12,
  totalMemGB: 32,
  availableMemGB: 20,
  load1: 2.5,
  oursCores: 1.5,
  budgetCores: 6,
  budgetShare: 0.8,
  budgetCoreUnits: 9.6,
  agentCostMemGB: 1.5,
  freeQuotaMemGB: 16,
  usableCoreUnits: 9.6,
  usedCoreUnits: 2.4,
  usedMemGB: 4,
  otherCoreUnits: 1,
  frozen: 0,
  reason: '12 cores, base 4',
  running: 2,
  ...over,
});

const stateWith = (running: number, over: Partial<GlobalDispatchCapState> = {}): GlobalDispatchCapState => ({
  cap: { auto: true, max: 3, mode: 'count', budgetShare: 0.8 },
  checksFloorGB: CHECKS_MEM_FLOOR_DEFAULT_GB,
  capacity: machine({ running }),
  saving: false,
  spend: null,
  ...over,
});

describe('dispatchLoadReading', () => {
  test('under the ceiling: partial ring, neutral, one plain word', () => {
    const r = dispatchLoadReading(stateWith(2));
    expect(r).toMatchObject({ running: 2, limit: 4, fill: 0.5, tone: 'idle', loading: false });
    expect(loadWordKey(r)).toBe('board.gauge.light');
    expect(loadToneClass(r)).toContain('text-app-text-secondary');
  });

  test('at the ceiling: the ring is full and the word changes with it', () => {
    const r = dispatchLoadReading(stateWith(4));
    expect(r.fill).toBe(1);
    expect(r.tone).toBe('full');
    expect(loadWordKey(r)).toBe('board.gauge.full');
    expect(loadToneClass(r)).toContain('amber');
  });

  test('past the ceiling: the ring cannot overflow, the tone says it', () => {
    const r = dispatchLoadReading(stateWith(5));
    expect(r.fill).toBe(1);
    expect(r.tone).toBe('over');
    expect(loadWordKey(r)).toBe('board.gauge.over');
    expect(loadToneClass(r)).toContain('rose');
  });

  test('no probe yet in auto: nothing is drawn as full, and nothing is invented', () => {
    const r = dispatchLoadReading({ cap: { auto: true, max: 3, mode: 'count', budgetShare: 0.8 }, capacity: null, saving: false, spend: null, checksFloorGB: CHECKS_MEM_FLOOR_DEFAULT_GB });
    expect(r.loading).toBe(true);
    expect(r.fill).toBe(0);
    expect(loadWordKey(r)).toBe('board.gauge.reading');
  });

  test('cap switched off: empty ring, and the word says there is no ceiling', () => {
    const r = dispatchLoadReading(stateWith(7, { cap: { auto: false, max: 0, mode: 'count', budgetShare: 0.8 } }));
    expect(r.unbounded).toBe(true);
    expect(r.fill).toBe(0);
    expect(r.running).toBe(7);
    expect(loadWordKey(r)).toBe('board.gauge.noLimit');
  });

  test('braking on the budget: the ring fills with use over budget, not with agents', () => {
    const r = dispatchLoadReading(stateWith(3, { cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.8 } }));
    expect(r.byResources).toBe(true);
    expect(r.limit).toBe(null);
    // 2.4 core-units of a 9.6 budget: a quarter of the ring, and 20% of a
    // twelve-core machine.
    expect(r.fill).toBeCloseTo(0.25, 5);
    expect(r.usedShare).toBeCloseTo(0.2, 5);
    expect(r.budgetShare).toBe(0.8);
    expect(loadWordKey(r)).toBe('board.gauge.byResources');
  });

  test('at and over the budget the tone says so: the ring cannot overflow', () => {
    const at = dispatchLoadReading(stateWith(3, {
      cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.8 },
      capacity: machine({ usedCoreUnits: 9.6 }),
    }));
    expect(at.fill).toBe(1);
    expect(at.tone).toBe('full');
    const over = dispatchLoadReading(stateWith(3, {
      cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.8 },
      capacity: machine({ usedCoreUnits: 14 }),
    }));
    expect(over.fill).toBe(1);
    expect(over.tone).toBe('over');
    expect(loadToneClass(over)).toContain('rose');
  });

  test('the ring fills against what is usable, not against the whole budget', () => {
    // Other processes hold most of the machine: 3 of the 9.6 core-units are
    // usable, and 2.4 of them are ours. The gate is close to "wait", so the
    // ring must be too.
    const r = dispatchLoadReading(stateWith(3, {
      cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.8 },
      capacity: machine({ usableCoreUnits: 3, usedCoreUnits: 2.4 }),
    }));
    expect(r.fill).toBeCloseTo(0.8, 5);
    const at = dispatchLoadReading(stateWith(3, {
      cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.8 },
      capacity: machine({ usableCoreUnits: 3, usedCoreUnits: 3.5 }),
    }));
    expect(at.tone).toBe('over');
    // A measured zero is a ceiling too: the ring is full and past it, not
    // drawn against the whole budget.
    const none = dispatchLoadReading(stateWith(3, {
      cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.8 },
      capacity: machine({ usableCoreUnits: 0, usedCoreUnits: 1.2 }),
    }));
    expect(none.fill).toBe(1);
    expect(none.tone).toBe('over');
  });

  test('braking on the budget with nothing measured yet: empty ring, nothing invented', () => {
    const r = dispatchLoadReading(stateWith(3, {
      cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.8 },
      capacity: machine({ usedCoreUnits: null }),
    }));
    expect(r.fill).toBe(0);
    expect(r.usedShare).toBe(null);
  });

  test('frozen check runs travel with the reading: the popover has a line for them', () => {
    const r = dispatchLoadReading(stateWith(3, {
      cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.8 },
      capacity: machine({ frozen: 2 }),
    }));
    expect(r.frozen).toBe(2);
  });

  test('a fixed number is the ceiling, not the recommendation', () => {
    const r = dispatchLoadReading(stateWith(2, { cap: { auto: false, max: 2, mode: 'count', budgetShare: 0.8 } }));
    expect(r.limit).toBe(2);
    expect(r.tone).toBe('full');
  });
});

/**
 * THE GATE HOLDS, AND THE RING SAYS SO. The reading used to fill with the CPU
 * alone and to say "a budget" whatever the gate answered: memory holding the
 * queue drew a neutral ring at 61%, and the 6 GB floor under a count cap drew
 * "3 of 4", which reads as a free slot.
 */
describe('the gate holds', () => {
  const resources = { auto: false, max: 5, mode: 'resources' as const, budgetShare: 0.6 };
  const wait = (blockedBy: 'cpu' | 'memory' | 'floor' | 'drain', over: Partial<DispatchAdmission> = {}): DispatchAdmission =>
    ({ admit: false, blockedBy, firstAgentExempt: false, costCoreUnits: 0.5, ...over });

  test('memory holds on the budget brake: full ring, the word names memory', () => {
    const r = dispatchLoadReading(stateWith(16, {
      cap: resources,
      capacity: machine({ running: 16, usedCoreUnits: 4, usableCoreUnits: 6.6, admission: wait('memory') }),
    }));
    expect(r.heldBy).toBe('memory');
    expect(r.fill).toBe(1);
    expect(r.tone).toBe('full');
    expect(loadWordKey(r)).toBe('board.gauge.wait.memory');
    expect(loadToneClass(r)).toContain('amber');
  });

  test('the floor holds by count: "3 of 4" is not a free slot', () => {
    const r = dispatchLoadReading(stateWith(3, {
      capacity: machine({ running: 3, admission: wait('floor', { costCoreUnits: 0, reason: 'Memoria quasi finita: 5.5 GB disponibili.' }) }),
    }));
    expect(r.limit).toBe(4);
    expect(r.fill).toBe(1);
    expect(r.tone).toBe('over');
    expect(loadWordKey(r)).toBe('board.gauge.wait.floor');
    expect(loadToneClass(r)).toContain('rose');
    // A pass is not a hold: the exemption keeps the ordinary reading.
    const exempt = dispatchLoadReading(stateWith(0, {
      cap: resources,
      capacity: machine({ running: 0, usedCoreUnits: 1, usableCoreUnits: 6.6, admission: { admit: true, blockedBy: 'cpu', firstAgentExempt: true, costCoreUnits: 0.5 } }),
    }));
    expect(exempt.heldBy).toBe(null);
    expect(loadWordKey(exempt)).toBe('board.gauge.byResources');
  });

  test('the ring fills with the gate\'s use, reservation included, not the bare probe', () => {
    const r = dispatchLoadReading(stateWith(4, {
      cap: resources,
      capacity: machine({ running: 4, usedCoreUnits: 2, usableCoreUnits: 6.6,
        admission: { admit: true, blockedBy: null, firstAgentExempt: false, costCoreUnits: 1, usedCoreUnits: 3.3, usableCoreUnits: 6.6, pendingAdmissions: 1 } }),
    }));
    expect(r.fill).toBeCloseTo(0.5, 5);
    expect(gateCoreNumbers(machine({ usedCoreUnits: 2, usableCoreUnits: 6.6 }))).toEqual({ used: 2, usable: 6.6, pending: 0 });
  });
});

describe('cpuPercent and memPercent', () => {
  test('cpuPercent is load1/cores, rounded, and never null when both are known', () => {
    expect(cpuPercent(machine({ load1: 2.5, cores: 12 }))).toBe(21); // 2.5/12 = 20.83%
    expect(cpuPercent(machine({ load1: 12, cores: 12 }))).toBe(100);
  });

  test('cpuPercent clamps to 0-100 and is null with no probe', () => {
    expect(cpuPercent(machine({ load1: 24, cores: 12 }))).toBe(100); // load past the machine still reads 100%, not 200%
    expect(cpuPercent(machine({ load1: -1, cores: 12 }))).toBe(0);
    expect(cpuPercent(null)).toBe(null);
    expect(cpuPercent(machine({ cores: 0 }))).toBe(null);
  });

  test('memPercent is 1 - available/total, rounded, and null when unmeasured (off macOS)', () => {
    expect(memPercent(machine({ totalMemGB: 32, availableMemGB: 20 }))).toBe(38); // 1 - 20/32 = 37.5%
    expect(memPercent(machine({ totalMemGB: 32, availableMemGB: null }))).toBe(null);
    expect(memPercent(null)).toBe(null);
    expect(memPercent(machine({ totalMemGB: 0, availableMemGB: 20 }))).toBe(null);
  });

  test('memPercent never reads 0% when unmeasured: null is not a fake floor', () => {
    // A literal 0% would look like the safest state there is; unmeasured stays null.
    expect(memPercent(machine({ totalMemGB: 32, availableMemGB: null }))).not.toBe(0);
  });
});

describe('admissionVerdictText', () => {
  const base = { admit: false, firstAgentExempt: false, costCoreUnits: 0.5 };
  // cores: 12, load1: 2.5 -> 21% CPU; totalMemGB: 32, availableMemGB: 20 -> 38% memory.
  const cap = machine();

  test('CPU held but a new agent would fit under the ceiling: the resume line', () => {
    // usable 5.5, used+cost 5.4 stays under it -> the gate restarts on its own.
    // resume = (5.5 * 0.8 - 1) / 12 cores = 28%.
    expect(admissionVerdictText({ ...base, blockedBy: 'cpu', costCoreUnits: 1, usedCoreUnits: 4.4, usableCoreUnits: 5.5 }, cap))
      .toMatchObject({ key: 'board.dispatch.verdictWaitCpu', params: { pct: 21, resume: 28 }, tone: 'wait' });
  });

  test('CPU held and one more agent would still not fit: cost alone, no resume line', () => {
    // used+cost (6.5+0.5) is past usable (6.6): printing a resume line here
    // would contradict the numbers beside it.
    expect(admissionVerdictText({ ...base, blockedBy: 'cpu', usedCoreUnits: 6.5, usableCoreUnits: 6.6 }, cap))
      .toMatchObject({ key: 'board.dispatch.verdictWaitCpuBare', params: { cost: 4 } });
  });

  test('CPU held, no probe at all (an old server): the axis is still named, nothing invented', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'cpu' }, null).key).toBe('board.dispatch.verdictWaitCpuUnmeasured');
  });

  test('memory held on Topics’ own footprint: the ceiling as a share of the whole Mac', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'memory', memClause: 'footprint', usableMemGB: 20.4 }, cap))
      .toMatchObject({ key: 'board.dispatch.verdictWaitMemory', params: { pct: 38, resume: 64 }, tone: 'wait' });
  });

  test('memory held on the quota: the current reading, no threshold to derive', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'memory', memClause: 'quota' }, cap))
      .toMatchObject({ key: 'board.dispatch.verdictWaitMemoryBare', params: { pct: 38 } });
  });

  test('memory held, nothing measured (off macOS): the axis is still named, nothing invented', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'memory' }, null).key).toBe('board.dispatch.verdictWaitMemoryUnmeasured');
  });

  test('the drain and the pass-through cases stay as they were', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'drain', reason: 'Riavvio del server in arrivo.' }, cap).key).toBe('board.dispatch.verdictWaitDrain');
    expect(admissionVerdictText({ admit: true, blockedBy: null, firstAgentExempt: false, costCoreUnits: 0.5 }, cap))
      .toMatchObject({ key: 'board.dispatch.verdictGo', tone: 'go' });
    expect(admissionVerdictText({ admit: true, blockedBy: null, firstAgentExempt: true, costCoreUnits: 0.5 }, cap))
      .toMatchObject({ key: 'board.dispatch.verdictFirst', tone: 'first' });
  });

  test('the resume number is the one the gate really restarts at, cost included', () => {
    // Share 0.5 of 12 cores, others burning 1, one agent priced at 1 core: the
    // usable is 5.5 and the gate, once holding, compares use + cost with 4.4.
    // The panel used to print "under 4.4" beside a use of 3.5 that still held.
    const sample = (ours: number) => ({
      cores: 12, totalMemGB: 32, ourCoreUnits: ours, otherCoreUnits: 1, ourMemGB: 2, availableMemGB: null, running: 2,
    });
    const cost = { coreUnits: 1, memGB: 1.5 };
    const held = admissionVerdict(sample(3.5), 0.5, cost, 'holding');
    expect(held).toMatchObject({ admit: false, blockedBy: 'cpu', usableCoreUnits: 5.5 });
    const text = admissionVerdictText({ ...base, blockedBy: 'cpu', costCoreUnits: held.costCoreUnits,
      usedCoreUnits: held.usedCoreUnits, usableCoreUnits: held.usableCoreUnits }, cap);
    expect(text.key).toBe('board.dispatch.verdictWaitCpu');
    const printed = (text.params!.resume as number) / 100 * cap.cores;
    // The use beside the sentence is not yet under the printed line...
    expect(held.usedCoreUnits).toBeGreaterThan(printed);
    // ...and at the printed line the gate does restart.
    expect(admissionVerdict(sample(printed), 0.5, cost, 'holding').admit).toBe(true);
    // A cost above 80% of the usable never prints a negative percentage.
    expect(admissionVerdictText({ ...base, blockedBy: 'cpu', costCoreUnits: 5, usedCoreUnits: 0.5, usableCoreUnits: 5.5 }, cap).params)
      .toMatchObject({ resume: 0 });
  });

  test('the floor is said in its own first sentence, the rest one hover away', () => {
    const reason = 'Memoria quasi finita: 5.5 GB disponibili, sotto il pavimento di 6 GB. Riprendo appena si libera memoria.';
    const v = admissionVerdictText({ ...base, blockedBy: 'floor', reason }, cap);
    expect(v).toMatchObject({ key: 'board.dispatch.verdictWaitFloor', tone: 'wait', title: reason });
    expect(v.params).toEqual({ reason: 'memoria quasi finita, 5.5 GB disponibili, sotto il pavimento di 6 GB' });
  });

  test('the floor with no reason (an old server) says only that there is no room', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'floor' }, cap).key).toBe('board.dispatch.verdictWaitFloorBare');
  });

  test('a floor reason that still names cores falls back to the bare sentence: the server composes its own words, this module never surfaces the retired vocabulary verbatim', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'floor', reason: '12 core al limite.' }, cap).key)
      .toBe('board.dispatch.verdictWaitFloorBare');
    expect(admissionVerdictText({ ...base, blockedBy: 'floor', reason: 'load average troppo alto.' }, cap).key)
      .toBe('board.dispatch.verdictWaitFloorBare');
  });
});

/**
 * THE ADVICE CHIP answers a count question. In "per risorse" `recommended` is
 * still the count figure, and the chip drew a red "Fermane 12" on a machine
 * whose gate admitted the next agent.
 */
describe('loadAdvice', () => {
  test('by count, over the recommendation: stop the difference', () => {
    expect(loadAdvice(stateWith(16, { capacity: machine({ running: 16, recommended: 4 }) }))).toEqual({ over: 12, severe: true });
    expect(loadAdvice(stateWith(3, { capacity: machine({ running: 3, recommended: 4 }) }))).toBe(null);
  });

  test('by resources, and with the mode unread, it says nothing', () => {
    expect(loadAdvice(stateWith(16, {
      cap: { auto: false, max: 5, mode: 'resources', budgetShare: 0.6 },
      capacity: machine({ running: 16, recommended: 4 }),
    }))).toBe(null);
    expect(loadAdvice(stateWith(16, { cap: null, capacity: machine({ running: 16, recommended: 4 }) }))).toBe(null);
  });

  test('the chip draws what loadAdvice says, not its own arithmetic', () => {
    const src = readFileSync(join(import.meta.dir, 'KanbanBoardPane.tsx'), 'utf8');
    const chip = src.slice(src.indexOf('function LoadAdviceChip'), src.indexOf('function MissionsMenu'));
    expect(chip).toContain('loadAdvice(');
    expect(chip).not.toMatch(/-\s*cap\.recommended/);
  });
});

describe('limitDerivation', () => {
  test('in auto the machine derived it, so the popover may say how', () => {
    expect(limitDerivation(stateWith(2))).toEqual({ cores: 12, limit: 4 });
  });

  test('a typed number explains itself: no cores claimed next to it', () => {
    expect(limitDerivation(stateWith(2, { cap: { auto: false, max: 2, mode: 'count', budgetShare: 0.8 } }))).toBe(null);
  });

  test('braking on resources: the ceiling is not a number, nothing to derive', () => {
    expect(limitDerivation(stateWith(2, { cap: { auto: true, max: 3, mode: 'resources', budgetShare: 0.8 } }))).toBe(null);
  });

  test('no ceiling, nothing to derive', () => {
    expect(limitDerivation(stateWith(2, { cap: { auto: false, max: 0, mode: 'count', budgetShare: 0.8 } }))).toBe(null);
  });
});
