/**
 * Unit tests for the desktop interaction summary and its reporting rule.
 *
 * Run one file at a time from the worktree root, the box is loaded:
 * OFFLOAD=local bun test client/src/lib/eventTimingReport.test.ts
 *
 * @covers INTERACTION-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { InteractionSnapshot } from './eventTiming';
import { getEventTimingSnapshot, recordEventEntries, resetEventTimingForTests } from './eventTiming';
import {
  buildInteractionSummary,
  resetInteractionReportForTests,
  shouldReportInteractions,
  startInteractionReport,
} from './eventTimingReport';
import { __queuedPaneAttachTraceForTests, __setPaneAttachTraceSendForTests } from './paneAttachTrace';

const globals = globalThis as unknown as Record<string, unknown>;

function snapshot(total: number, slow: number, worstMs: number | null): InteractionSnapshot {
  return {
    supported: true,
    total,
    slow,
    worst: worstMs === null ? null : { name: 'click', durationMs: worstMs, target: 'button', atMs: 7 },
    recent: [],
    histogram: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    p95Ms: null,
  };
}

afterEach(() => {
  resetInteractionReportForTests();
  resetEventTimingForTests();
  __setPaneAttachTraceSendForTests(null);
  delete globals.window;
  delete globals.document;
});

describe('buildInteractionSummary', () => {
  test('packs the compact shell line', () => {
    expect(buildInteractionSummary(snapshot(120, 6, 210), 'abc123')).toEqual({
      shell: 'tauri',
      pl: 'abc123',
      n: 120,
      s: 6,
      w: 210,
      h: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
  });

  test('an empty store reports zero worst', () => {
    expect(buildInteractionSummary(snapshot(0, 0, null), 'abc123').w).toBe(0);
  });

  test('serialises under 300 characters', () => {
    const summary = buildInteractionSummary(snapshot(1000000, 9999, 1200), 'abcdef');
    expect(JSON.stringify(summary).length).toBeLessThan(300);
  });
});

describe('shouldReportInteractions', () => {
  test('never with an empty store, even forced', () => {
    expect(shouldReportInteractions({ total: 0, at: 0 }, snapshot(0, 0, null), 999999, true)).toBe(false);
  });

  test('first line needs something counted, then force or a minute since load', () => {
    const load = { total: 0, at: 1000 };
    expect(shouldReportInteractions(load, snapshot(0, 0, null), 62000, false)).toBe(false);
    expect(shouldReportInteractions(load, snapshot(5, 1, 30), 2000, false)).toBe(false);
    expect(shouldReportInteractions(load, snapshot(5, 1, 30), 2000, true)).toBe(true);
    expect(shouldReportInteractions(load, snapshot(5, 1, 30), 60999, false)).toBe(false);
    expect(shouldReportInteractions(load, snapshot(5, 1, 30), 61000, false)).toBe(true);
  });

  test('later lines need a moved total, then force or a minute', () => {
    const previous = { total: 5, at: 1000 };
    expect(shouldReportInteractions(previous, snapshot(5, 1, 30), 70000, true)).toBe(false);
    expect(shouldReportInteractions(previous, snapshot(8, 2, 30), 2000, false)).toBe(false);
    expect(shouldReportInteractions(previous, snapshot(8, 2, 30), 2000, true)).toBe(true);
    expect(shouldReportInteractions(previous, snapshot(8, 2, 30), 61000, false)).toBe(true);
  });
});

describe('startInteractionReport', () => {
  test('stays silent outside the desktop shell', () => {
    __setPaneAttachTraceSendForTests(async () => true);
    startInteractionReport();
    recordEventEntries([{ name: 'click', duration: 40, startTime: 10, interactionId: 3 }]);
    expect(getEventTimingSnapshot().slow).toBe(1);
    expect(__queuedPaneAttachTraceForTests()).toHaveLength(0);
  });

  test('reports the summary on hide in the desktop shell', () => {
    const shown: Array<() => void> = [];
    globals.window = { __TAURI_INTERNALS__: {}, addEventListener: () => {} };
    globals.document = {
      visibilityState: 'visible',
      addEventListener: (type: string, callback: () => void) => {
        if (type === 'visibilitychange') shown.push(callback);
      },
    };
    __setPaneAttachTraceSendForTests(async () => true);
    startInteractionReport();
    recordEventEntries([{ name: 'click', duration: 40, startTime: 10, interactionId: 3 }]);
    expect(__queuedPaneAttachTraceForTests()).toHaveLength(0);
    const page = globals.document as { visibilityState: string };
    page.visibilityState = 'hidden';
    for (const callback of shown) callback();
    const queued = __queuedPaneAttachTraceForTests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.event).toBe('inp-summary');
    expect((queued[0]?.fields as Record<string, unknown>)?.shell).toBe('tauri');
  });
});
