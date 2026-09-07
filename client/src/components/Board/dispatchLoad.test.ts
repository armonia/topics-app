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
import { dispatchLoadReading, limitDerivation, loadToneClass, loadWordKey } from './dispatchLoad';
import type { GlobalDispatchCapState } from '../../state/globalDispatchCap';
import type { DispatchCapacity } from '../../lib/board';

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
    const r = dispatchLoadReading({ cap: { auto: true, max: 3, mode: 'count', budgetShare: 0.8 }, capacity: null, saving: false, spend: null });
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
