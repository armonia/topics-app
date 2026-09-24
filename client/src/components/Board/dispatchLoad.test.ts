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
import { admissionVerdictText, dispatchLoadReading, gateCoreNumbers, limitDerivation, loadAdvice, loadToneClass, loadWordKey, verdictSentence } from './dispatchLoad';
import { t } from '../../lib/i18n';
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

describe('admissionVerdictText: the wait said in the one number', () => {
  const base = { admit: false, firstAgentExempt: false, costCoreUnits: 0.5 };
  // CPU 92% of the Mac, memory 38% (1 - 20/32): the one number is 92, made by the CPU.
  const cpuBound = machine({ machineCpuPct: 92, machineMemPct: 38 });
  const itText = (v: ReturnType<typeof admissionVerdictText>) => verdictSentence(v, (k, vars) => t(k, 'it', vars), 'it');

  test('CPU holds and makes the number: the resume point is the number minus the drop the gate needs', () => {
    // Gate reopens when used + cost <= 0.8 x usable: 6.5 + 0.5 - 0.8 x 6.6 = 1.72
    // core-units too many, 14.3% of 12 cores. 92 - 14.3 = 78.
    const v = admissionVerdictText({ ...base, blockedBy: 'cpu', usedCoreUnits: 6.5, usableCoreUnits: 6.6 }, cpuBound);
    expect(v).toMatchObject({ key: 'board.dispatch.verdictWaitBusyResume', params: { pct: 92, resume: 78 }, tone: 'wait' });
    expect(itText(v)).toBe('In attesa: il Mac è occupato al 92%, parte da solo sotto il 78%');
  });

  test('memory holds but the CPU makes the number: no resume point, it would not be true', () => {
    const v = admissionVerdictText({ ...base, blockedBy: 'memory', memClause: 'footprint', ourMemGB: 22, usableMemGB: 20.4 }, cpuBound);
    expect(v).toMatchObject({ key: 'board.dispatch.verdictWaitBusy', params: { pct: 92 } });
  });

  test('memory footprint holds and makes the number: the drop is the GB over the ceiling', () => {
    // 22.0 - 20.4 = 1.6 GB of 34 = 4.7 points under 79.
    const v = admissionVerdictText({ ...base, blockedBy: 'memory', memClause: 'footprint', ourMemGB: 22, usableMemGB: 20.4 },
      machine({ totalMemGB: 34, machineCpuPct: 30, machineMemPct: 79 }));
    expect(v).toMatchObject({ key: 'board.dispatch.verdictWaitBusyResume', params: { pct: 79, resume: 74 } });
  });

  test('memory quota holds: no single resume line exists, none is printed', () => {
    const v = admissionVerdictText({ ...base, blockedBy: 'memory', memClause: 'quota', costMemGB: 4, freeQuotaMemGB: 3.3 },
      machine({ machineCpuPct: 10, machineMemPct: 90 }));
    expect(v).toMatchObject({ key: 'board.dispatch.verdictWaitBusy', params: { pct: 90 } });
  });

  test('no gate numbers (an old server): the number, and no invented point', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'cpu' }, cpuBound).key).toBe('board.dispatch.verdictWaitBusy');
  });

  test('nothing measured: the wait is said without a number', () => {
    expect(admissionVerdictText({ ...base, blockedBy: 'cpu' }, machine({ availableMemGB: null })).key).toBe('board.dispatch.verdictWaitBusyUnknown');
    expect(admissionVerdictText({ ...base, blockedBy: 'memory' }, null).key).toBe('board.dispatch.verdictWaitBusyUnknown');
  });

  test('the floor and the drain keep plain words, the server sentence one hover away', () => {
    const reason = 'Memoria quasi finita: 5.5 GB disponibili, sotto il pavimento di 6 GB.';
    const v = admissionVerdictText({ ...base, blockedBy: 'floor', reason }, cpuBound);
    expect(v).toMatchObject({ key: 'board.dispatch.verdictWaitFloor', title: reason });
    expect(itText(v)).not.toMatch(/GB|core|CPU|memoria/);
    expect(admissionVerdictText({ ...base, blockedBy: 'drain' }, cpuBound).key).toBe('board.dispatch.verdictWaitDrain');
  });

  test('passes stay as they were', () => {
    expect(admissionVerdictText({ admit: true, blockedBy: null, firstAgentExempt: false, costCoreUnits: 0.5 }, cpuBound))
      .toMatchObject({ key: 'board.dispatch.verdictGo', tone: 'go' });
    expect(admissionVerdictText({ admit: true, blockedBy: null, firstAgentExempt: true, costCoreUnits: 0.5 }, cpuBound))
      .toMatchObject({ key: 'board.dispatch.verdictFirst', tone: 'first' });
  });

  test('the printed resume point is where the gate really reopens (the gate is unchanged)', () => {
    const sample = (ourCoreUnits: number) => ({ cores: 12, totalMemGB: 32, ourCoreUnits, otherCoreUnits: 1, ourMemGB: 4, availableMemGB: 20, running: 2 });
    const cost = { coreUnits: 1, memGB: 1.5 };
    const held = admissionVerdict(sample(3.5), 0.5, cost, 'holding');
    expect(held).toMatchObject({ admit: false, blockedBy: 'cpu' });
    // The Mac reads 50% CPU while holding; the sentence says where it reopens.
    const v = admissionVerdictText({ ...base, blockedBy: 'cpu', costCoreUnits: held.costCoreUnits,
      usedCoreUnits: held.usedCoreUnits, usableCoreUnits: held.usableCoreUnits }, machine({ machineCpuPct: 50, machineMemPct: 38 }));
    const resume = v.params!.resume as number;
    // Our use has to fall by (50 - resume)% of 12 cores: there the gate admits.
    const ourAtResume = held.usedCoreUnits - ((50 - resume) / 100) * 12;
    expect(admissionVerdict(sample(ourAtResume - 0.05), 0.5, cost, 'holding').admit).toBe(true);
    expect(admissionVerdict(sample(ourAtResume + 0.2), 0.5, cost, 'holding').admit).toBe(false);
  });
});

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
