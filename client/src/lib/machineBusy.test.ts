/**
 * THE ONE NUMBER: how busy the whole Mac is, the larger of CPU% and memory%.
 * @covers KANBAN-79
 */
import { describe, expect, test } from 'bun:test';
import { busiestPct, busyTone, machineBusyPct, machineMemPct } from './machineBusy';

describe('machineBusyPct', () => {
  test('the larger of the two, not the average', () => {
    expect(machineBusyPct({ machineCpuPct: 92, machineMemPct: 40 })).toBe(92);
    expect(machineBusyPct({ machineCpuPct: 12, machineMemPct: 71 })).toBe(71);
  });

  test('one axis measured: that one is the answer', () => {
    expect(machineBusyPct({ machineCpuPct: 33, machineMemPct: null })).toBe(33);
    expect(machineBusyPct({ machineCpuPct: null, machineMemPct: 58 })).toBe(58);
  });

  test('nothing measured is null, never an invented 0%', () => {
    expect(machineBusyPct({ machineCpuPct: null, machineMemPct: null })).toBeNull();
    expect(machineBusyPct(null)).toBeNull();
    expect(machineBusyPct({})).toBeNull();
  });

  test('an older server without the field: memory from its GB, CPU never from load1', () => {
    // 1 - 8/32 = 75%. `load1` is not in the input type at all: a run-queue
    // length divided by cores is not a CPU share, so it cannot leak in here.
    expect(machineMemPct({ availableMemGB: 8, totalMemGB: 32 })).toBe(75);
    expect(machineBusyPct({ availableMemGB: 8, totalMemGB: 32 })).toBe(75);
  });

  test('clamped to the machine, rounded', () => {
    expect(busiestPct(130, -5)).toBe(100);
    expect(machineBusyPct({ machineCpuPct: 59.6 })).toBe(60);
  });
});

describe('busyTone: green under 60, amber 60-85, red over 85', () => {
  test('the edges', () => {
    expect(busyTone(0)).toBe('ok');
    expect(busyTone(59)).toBe('ok');
    expect(busyTone(60)).toBe('busy');
    expect(busyTone(85)).toBe('busy');
    expect(busyTone(86)).toBe('critical');
    expect(busyTone(null)).toBe('unknown');
  });
});
