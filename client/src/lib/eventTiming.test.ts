/**
 * Unit tests for the Event Timing store: grouping, buckets, caps and totals.
 *
 * Run one file at a time from the worktree root, the box is loaded:
 * OFFLOAD=local bun test client/src/lib/eventTiming.test.ts
 *
 * @covers INTERACTION-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { EventTimingLike } from './eventTiming';
import {
  getEventTimingSnapshot,
  recordEventEntries,
  refreshTotal,
  resetEventTimingForTests,
  startEventTiming,
  subscribeEventTiming,
} from './eventTiming';

type ObserverCallback = (list: { getEntries(): EventTimingLike[] }) => void;

const globals = globalThis as unknown as Record<string, unknown>;
const realObserver = globals.PerformanceObserver;
const realPerformance = globals.performance;

let seenCallback: ObserverCallback | null = null;
let observedWith: unknown = null;
let constructed = 0;

function installObserver(kinds: readonly string[] | undefined, throws: boolean): void {
  seenCallback = null;
  observedWith = null;
  constructed = 0;
  globals.PerformanceObserver = class {
    static supportedEntryTypes = kinds;
    constructor(callback: ObserverCallback) {
      constructed += 1;
      seenCallback = callback;
    }
    observe(options: unknown): void {
      observedWith = options;
      if (throws) throw new Error('observe rejected');
    }
    disconnect(): void {}
  };
}

function fireEntries(entries: EventTimingLike[]): void {
  if (seenCallback === null) throw new Error('observer callback missing');
  seenCallback({ getEntries: () => entries });
}

function entry(id: number, duration: number, start = 1000): EventTimingLike {
  return { name: 'click', duration, startTime: start, interactionId: id };
}

function histogramCount(histogram: readonly number[]): number {
  let sum = 0;
  for (const count of histogram) sum += count;
  return sum;
}

afterEach(() => {
  resetEventTimingForTests();
  globals.PerformanceObserver = realObserver;
  globals.performance = realPerformance;
});

describe('eventTiming', () => {
  test('entries sharing one interaction count once, at the longest duration', () => {
    recordEventEntries([entry(5, 20, 100), entry(5, 45, 140), entry(5, 30, 160)]);
    const snapshot = getEventTimingSnapshot();
    expect(snapshot.slow).toBe(1);
    expect(histogramCount(snapshot.histogram)).toBe(1);
    expect(snapshot.histogram[3]).toBe(1);
    expect(snapshot.worst?.durationMs).toBe(45);
    expect(snapshot.recent).toHaveLength(1);
  });

  test('a longer later entry moves the bucket without counting twice', () => {
    recordEventEntries([entry(7, 20)]);
    recordEventEntries([entry(7, 50)]);
    const snapshot = getEventTimingSnapshot();
    expect(snapshot.slow).toBe(1);
    expect(snapshot.histogram[0]).toBe(0);
    expect(snapshot.histogram[4]).toBe(1);
    expect(histogramCount(snapshot.histogram)).toBe(1);
    expect(snapshot.recent).toHaveLength(1);
    expect(snapshot.recent[0]?.durationMs).toBe(50);
  });

  test('a shorter later entry changes nothing', () => {
    recordEventEntries([entry(7, 50)]);
    const before = getEventTimingSnapshot();
    recordEventEntries([entry(7, 30)]);
    expect(getEventTimingSnapshot()).toBe(before);
  });

  test('entries without an interaction id are ignored', () => {
    const before = getEventTimingSnapshot();
    recordEventEntries([
      { name: 'click', duration: 40, startTime: 10 },
      { name: 'click', duration: 40, startTime: 11, interactionId: 0 },
      { name: 'click', duration: 40, startTime: 12, interactionId: -2 },
    ]);
    const snapshot = getEventTimingSnapshot();
    expect(snapshot.slow).toBe(0);
    expect(snapshot.total).toBe(0);
    expect(getEventTimingSnapshot()).toBe(before);
  });

  test('worst survives while recent keeps the last 32', () => {
    const entries: EventTimingLike[] = [];
    for (let id = 1; id <= 40; id++) entries.push(entry(id, 20 + id));
    recordEventEntries(entries);
    const snapshot = getEventTimingSnapshot();
    expect(snapshot.slow).toBe(40);
    expect(snapshot.recent).toHaveLength(32);
    expect(snapshot.worst?.durationMs).toBe(60);
    const quiet: EventTimingLike[] = [];
    for (let id = 41; id <= 80; id++) quiet.push(entry(id, 17));
    recordEventEntries(quiet);
    const later = getEventTimingSnapshot();
    expect(later.slow).toBe(80);
    expect(later.recent).toHaveLength(32);
    expect(later.worst?.durationMs).toBe(60);
    expect(later.recent.every((item) => item.durationMs === 17)).toBe(true);
  });

  test('target is a short string, never the node', () => {
    const fake = { tagName: 'BUTTON', dataset: { testid: 'send' } };
    recordEventEntries([{ ...entry(1, 30), target: fake }]);
    const snapshot = getEventTimingSnapshot();
    expect(snapshot.recent[0]?.target).toBe('button[data-testid=send]');
    expect(typeof snapshot.recent[0]?.target).toBe('string');
  });

  test('elements without a test id fall back to the tag, other targets to the name', () => {
    recordEventEntries([
      { ...entry(1, 30), target: { tagName: 'DIV', dataset: {} } },
      { ...entry(2, 30), target: 42 },
      entry(3, 30),
    ]);
    const snapshot = getEventTimingSnapshot();
    expect(snapshot.recent[0]?.target).toBe('div');
    expect(snapshot.recent[1]?.target).toBe('click');
    expect(snapshot.recent[2]?.target).toBe('click');
  });

  test('stays unsupported without a PerformanceObserver', () => {
    globals.PerformanceObserver = undefined;
    const before = getEventTimingSnapshot();
    startEventTiming();
    startEventTiming();
    expect(getEventTimingSnapshot().supported).toBe(false);
    expect(getEventTimingSnapshot()).toBe(before);
  });

  test('stays unsupported when the engine lacks the event type', () => {
    installObserver(['navigation'], false);
    startEventTiming();
    expect(getEventTimingSnapshot().supported).toBe(false);
    expect(observedWith).toBeNull();
  });

  test('stays unsupported when observe throws', () => {
    installObserver(['event'], true);
    startEventTiming();
    expect(getEventTimingSnapshot().supported).toBe(false);
  });

  test('observes slow events once started', () => {
    installObserver(['event'], false);
    startEventTiming();
    startEventTiming();
    expect(constructed).toBe(1);
    expect(getEventTimingSnapshot().supported).toBe(true);
    expect(observedWith).toEqual({ type: 'event', durationThreshold: 16, buffered: true });
    fireEntries([entry(9, 40)]);
    expect(getEventTimingSnapshot().slow).toBe(1);
  });

  test('the snapshot reference only moves on change', () => {
    const first = getEventTimingSnapshot();
    expect(getEventTimingSnapshot()).toBe(first);
    recordEventEntries([]);
    expect(getEventTimingSnapshot()).toBe(first);
    recordEventEntries([entry(1, 40)]);
    expect(getEventTimingSnapshot()).not.toBe(first);
  });

  test('subscribers hear once per callback, and only on change', () => {
    let calls = 0;
    const stop = subscribeEventTiming(() => {
      calls += 1;
    });
    recordEventEntries([entry(1, 40)]);
    recordEventEntries([entry(1, 20)]);
    recordEventEntries([]);
    expect(calls).toBe(1);
    stop();
    recordEventEntries([entry(2, 40)]);
    expect(calls).toBe(1);
  });

  test('total falls back to event counts, and never below slow', () => {
    globals.performance = { eventCounts: new Map([['pointerup', 40], ['keydown', 12], ['click', 1000]]) };
    recordEventEntries([entry(1, 40), entry(2, 50)]);
    expect(getEventTimingSnapshot().total).toBe(52);
    globals.performance = { eventCounts: new Map([['pointerup', 1]]) };
    refreshTotal();
    expect(getEventTimingSnapshot().total).toBe(2);
  });

  test('interactionCount wins when present', () => {
    globals.performance = { interactionCount: 200 };
    refreshTotal();
    expect(getEventTimingSnapshot().total).toBe(200);
  });

  test('refreshTotal notifies only when the total moved', () => {
    globals.performance = { eventCounts: new Map([['pointerup', 9], ['keydown', 1]]) };
    let calls = 0;
    const stop = subscribeEventTiming(() => {
      calls += 1;
    });
    refreshTotal();
    expect(getEventTimingSnapshot().total).toBe(10);
    expect(calls).toBe(1);
    refreshTotal();
    expect(calls).toBe(1);
    stop();
  });

  test('p95 stays at the threshold while few interactions are slow', () => {
    globals.performance = { eventCounts: new Map([['pointerup', 60], ['keydown', 40]]) };
    expect(getEventTimingSnapshot().p95Ms).toBeNull();
    recordEventEntries([entry(1, 20)]);
    const snapshot = getEventTimingSnapshot();
    expect(snapshot.total).toBe(100);
    expect(snapshot.p95Ms).toBe(16);
  });
});
