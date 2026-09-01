/**
 * WHAT HOLDS THAT NUMBER, when the two halves are not both there.
 *
 * The paragraph explaining Topics' memory used to be inline in the strip at the
 * foot of the column and no test ever read it: it was extracted here on
 * 2026-08-31, when the strip became three rows in the menu. It is the part of
 * that strip with the least markup and the most branches — phone against
 * computer, partial reading against complete, fleet present against absent —
 * which is exactly what a test can hold still without a browser.
 *
 * THE BRANCH THAT MATTERS IS "NOT MEASURED". A missing total is NOT zero, and
 * the difference shows only here: in a browser the processes cannot be counted,
 * and a tooltip saying "0 MB" would state something false with precision.
 *
 * @covers PERFPANEL-01
 */
import { describe, expect, test } from 'bun:test';
import { composeUsageTooltip, usageFrom, wantsResidentLine } from './usageTooltip';
import type { PerfMetrics } from '../../hooks/usePerfMetrics';
import type { SystemStatus } from '../../hooks/useSystemStatus';

/** The shell measured in full, as in the desktop app on macOS. */
const perfFull = {
  partial: false,
  cpu: { renderer: 4, gpu: 1, total: 8, sampled: 3, pids: 3 },
  memory: { totalMB: 594, residentMB: 300, processCount: 7, metric: 'footprint' },
} as unknown as PerfMetrics;

/** The shell alone, without the WKWebView processes: the non-macOS case. */
const perfPartial = {
  partial: true,
  cpu: { renderer: 2, gpu: 0, total: 3, sampled: 1, pids: 4 },
  memory: { totalMB: 200, residentMB: 150, processCount: 1, metric: 'rss' },
} as unknown as PerfMetrics;

const statusWithFleet = {
  timestamp: '2026-08-31T12:00:00.000Z',
  gateway: { online: true, status: 'ok', latencyMs: 3, lastCheckedAt: null },
  server: {
    uptimeMs: 1000, startedAt: '', memoryMB: 500, heapUsedMB: 90, heapTotalMB: 120,
    fleet: {
      processCount: 4, memoryMB: 900, memMetric: 'footprint', cpuPercent: 12,
      scriptsMB: 0, scriptsProcessCount: 0, sessions: [],
      roots: [{ kind: 'agent', memoryMB: 400, processCount: 2 }, { kind: 'server', memoryMB: 500, processCount: 1 }],
    },
  },
} as unknown as SystemStatus;

const base = { isMobile: false, fps: 60, residentLine: null, inventory: null };

describe('the total and its two halves', () => {
  test('with both halves measured the total is the sum, and processes are counted', () => {
    const usage = usageFrom(perfFull, statusWithFleet);
    expect(usage.totalMB).toBe(594 + 900);
    expect(usage.totalProcessCount).toBe(7 + 4);
    expect(usage.memPartial).toBe(false);

    const t = composeUsageTooltip({ ...base, perf: perfFull, status: statusWithFleet });
    expect(t).toContain('Topics in tutto');
    expect(t).toContain('1.5GB'); // 1494 MB -> gigabytes with one decimal
    expect(t).toContain('su 11 processi');
    expect(t).not.toContain('~'); // no partial sign when it is not partial
  });

  test('with no shell (browser) the total is the server side alone, and it SAYS so', () => {
    const t = composeUsageTooltip({ ...base, perf: null, status: statusWithFleet });
    expect(t).toContain('~'); // the total covers one half only
    expect(t).toContain('c’è solo il lato server');
    // And the device half is not invented:
    expect(t).toContain('memoria e CPU non misurabili qui');
  });

  test('with NO measurement at all the total is not zero: it is «non misurata»', () => {
    const t = composeUsageTooltip({ ...base, perf: null, status: null });
    expect(t).toContain('memoria: non misurata');
    expect(t).toContain('CPU: non ancora misurata');
    expect(t).not.toContain('0MB');
    expect(t).not.toContain('0 processi'); // "zero processes" would be a precise lie
  });

  test('a partial shell reading says WHAT it does not cover', () => {
    const t = composeUsageTooltip({ ...base, perf: perfPartial, status: statusWithFleet });
    expect(t).toContain('~');
    expect(t).toContain('la lettura del dispositivo copre la sola shell');
    expect(t).toContain('NON include i processi WKWebView');
    // CPU sampled over part of the processes declares it instead of staying quiet:
    expect(t).toContain('misurata su 1/4 processi');
  });
});

describe('the device, the server and the reading order', () => {
  test('on a phone the device half is called a phone', () => {
    const t = composeUsageTooltip({ ...base, isMobile: true, perf: null, status: statusWithFleet });
    expect(t).toContain('Questo telefono');
    expect(t).not.toContain('Questo computer');
  });

  test('with no fleet the server is the Bun process alone, with its heap', () => {
    const withoutFleet = JSON.parse(JSON.stringify(statusWithFleet)) as SystemStatus;
    delete (withoutFleet.server as { fleet?: unknown }).fleet;
    const t = composeUsageTooltip({ ...base, perf: perfFull, status: withoutFleet });
    expect(t).toContain('processo Bun: 500 MB');
    expect(t).toContain('heap 90 MB');
    expect(t).toContain('CPU: non misurata');
  });

  test('the server roots show up, except the server itself', () => {
    const t = composeUsageTooltip({ ...base, perf: perfFull, status: statusWithFleet });
    expect(t).toContain('agent: 400 MB, 2 proc.');
    // `server` is already the line above: repeating it would count it twice by eye
    expect(t).not.toContain('server: 500 MB, 1 proc.');
  });

  test('THE INVENTORY IS LAST, after the total and after the two halves', () => {
    // Whoever hovers is after the number; the detail of what composes it is the
    // question AFTER, and putting it in front pushes down what was being sought.
    const t = composeUsageTooltip({
      ...base, perf: perfFull, status: statusWithFleet,
      inventory: 'Cosa tiene questo numero\n· Terminali e sessioni: 300 MB',
    });
    expect(t.indexOf('Topics in tutto')).toBeLessThan(t.indexOf('Questo computer'));
    expect(t.indexOf('Questo computer')).toBeLessThan(t.indexOf('Il server'));
    expect(t.indexOf('Il server')).toBeLessThan(t.indexOf('Cosa tiene questo numero'));
  });

  test('with no inventory no empty tail is left behind', () => {
    const t = composeUsageTooltip({ ...base, perf: perfFull, status: statusWithFleet });
    expect(t.endsWith('\n\n')).toBe(false);
    expect(t).not.toContain('\n\n\n');
  });
});

describe('the resident-share line', () => {
  test('it is not asked for when the compressed share is not substantial', () => {
    // 300 of 594: more than half is resident, the line would be noise.
    expect(wantsResidentLine(perfFull, statusWithFleet)).toBe(false);
  });

  test('the line, when the caller passes it, sits RIGHT under the memory line', () => {
    const t = composeUsageTooltip({
      ...base, perf: perfFull, status: statusWithFleet, residentLine: 'di cui in RAM adesso: 300 MB',
    });
    const lines = t.split('\n· ');
    const iMem = lines.findIndex((r) => r.startsWith('memoria:'));
    expect(lines[iMem + 1]).toContain('di cui in RAM adesso');
  });

  test('it is not asked for when the device cannot be measured', () => {
    expect(wantsResidentLine(null, statusWithFleet)).toBe(false);
  });
});
