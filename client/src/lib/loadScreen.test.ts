/**
 * The load screen's model: the readout, the countdown, the node's own cards.
 *
 * @covers HUBBR-21
 */
import { describe, expect, test } from 'bun:test';
import { cardsOn, elapsedParts, loadScreenMachine, procKind, projectLabel, readReadout, readoutRows, screenZoom, sleepView } from './loadScreen';

const NOW = Date.parse('2026-11-08T19:40:00+01:00');

function answer(screen: Record<string, unknown> | null) {
  return {
    machine: { id: 'pc-1', name: 'PC', local: false },
    readout: {
      at: NOW, platform: 'win32', cores: 16, memTotalMB: 32768, memMetric: 'working-set', total: 140,
      procs: [{ name: 'node', count: 3, memMB: 2048, cpuPct: 140 }, { name: 'msedge', count: 1, memMB: 512, cpuPct: null }, { name: 42 }],
      rest: { count: 120, memMB: 3000 },
      screen,
    },
    error: null,
  };
}

describe('load screen model', () => {
  test('reads the route answer and drops malformed rows', () => {
    const r = readReadout(answer(null));
    expect(r.machine).toEqual({ id: 'pc-1', name: 'PC', local: false });
    expect(r.procs.map((p) => p.name)).toEqual(['node', 'msedge']);
    expect(r.memMetric).toBe('working-set');
    expect(r.error).toBeNull();
    expect(readReadout({ machine: { id: 'x' }, readout: null, error: 'unreachable' }).error).toBe('unreachable');
    expect(readReadout(null).error).toBe('empty');
  });

  test('rows of the Processes view: share of the heaviest, warm past 1,5 GB, nothing invented', () => {
    const rows = readoutRows(readReadout(answer(null)), (n) => `${n} processi`);
    expect(rows[0]).toMatchObject({ name: 'node', detail: '3 processi', memShare: 1, memWarn: true, cpuPct: 140, gpuPct: null, netInBps: null });
    expect(rows[1]).toMatchObject({ detail: '', memShare: 0.25, memWarn: false, cpuPct: null });
  });

  test('what a program is: the system, an agent, a service, else an app', () => {
    expect(['dwm', 'System', 'MsMpEng', 'svchost'].map((n) => procKind(n, 'win32'))).toEqual(['macos', 'macos', 'macos', 'macos']);
    expect(procKind('claude', 'win32')).toBe('sessione');
    expect(procKind('bun', 'win32')).toBe('servizio');
    expect(procKind('msedge', 'win32')).toBe('app');
    expect(procKind('WindowServer', 'darwin')).toBe('macos');
    // A Windows name on the Mac is not its system.
    expect(procKind('dwm', 'darwin')).toBe('app');
    const rows = readoutRows(readReadout(answer(null)), (n) => `${n}`);
    expect(rows.map((r) => r.kind)).toEqual(['app', 'app']);
  });

  test('outcomes keep an interrupted run apart from a failed one', () => {
    const r = readReadout(answer({ outcomes: [{ what: 'e2e', ok: null, interrupted: true }, { what: 'test', ok: false }] }));
    expect(r.screen!.outcomes.map((o) => [o.ok, o.interrupted])).toEqual([[null, true], [false, false]]);
  });

  test('the countdown rounds up and never says 0 while awake', () => {
    const r = readReadout(answer({ sleepsAt: NOW + 12 * 60_000 + 1_000, reasons: [], jobs: [], outcomes: [], thresholdMin: 20 }));
    expect(sleepView(r, 0, NOW)).toEqual({ kind: 'countdown', minutes: 13, at: NOW + 12 * 60_000 + 1_000 });
    expect(sleepView(r, 0, NOW + 12 * 60_000 + 500)).toMatchObject({ kind: 'countdown', minutes: 1 });
    expect(sleepView(r, 0, NOW + 13 * 60_000)).toEqual({ kind: 'sleeping' });
  });

  test('a card or a job running means working, whatever the file says', () => {
    const r = readReadout(answer({ sleepsAt: NOW + 60_000, reasons: [], jobs: [], outcomes: [] }));
    expect(sleepView(r, 1, NOW)).toEqual({ kind: 'working' });
    const j = readReadout(answer({ sleepsAt: null, reasons: [], jobs: [{ project: 'acme-web', what: 'test', who: 'Mac', since: NOW }], outcomes: [] }));
    expect(sleepView(j, 0, NOW)).toEqual({ kind: 'working' });
    const awake = readReadout(answer({ sleepsAt: null, reasons: ['Il Mac è collegato al PC'], jobs: [], outcomes: [], thresholdMin: 20 }));
    expect(sleepView(awake, 0, NOW)).toEqual({ kind: 'working' });
    const none = readReadout(answer(null));
    expect(sleepView(none, 0, NOW)).toEqual({ kind: 'idle', thresholdMin: null });
  });

  test('cards on a node are its own; the local screen takes the unassigned ones', () => {
    const feed = { tasks: [
      { id: 'a', text: 'Card A', projectId: 'p', status: 'in_progress', machineId: 'pc-1', inProgressAt: '2026-11-08T19:30:00+01:00', model: 'sonnet', runInitiatorDeviceName: 'Mac' },
      { id: 'b', text: 'Card B', projectId: 'p', status: 'in_progress', machineId: null, inProgressAt: '2026-11-08T19:00:00+01:00' },
      { id: 'c', text: 'Card C', projectId: 'p', status: 'review', machineId: 'pc-1' },
      { id: 'd', text: 'Card D', projectId: 'p', status: 'in_progress', machineId: 'pc-1', inProgressAt: '2026-11-08T19:10:00+01:00' },
    ] };
    expect(cardsOn(feed, 'pc-1', false).map((c) => c.id)).toEqual(['d', 'a']);
    expect(cardsOn(feed, 'pc-1', false)[1]).toMatchObject({ model: 'sonnet', from: 'Mac' });
    expect(cardsOn(feed, 'mac-1', true).map((c) => c.id)).toEqual(['b']);
  });

  test('a card never names the machine it runs on as its sender', () => {
    const feed = { tasks: [{ id: 'a', text: 'A', projectId: 'p', status: 'in_progress', machineId: 'pc-1', runComputerName: 'PC' }] };
    expect(cardsOn(feed, 'pc-1', false)[0].from).toBeNull();
  });

  test('project label: the row by board id, else the id without its hash', () => {
    const rows = new Map([['acme-web-gr9brd', { name: 'Acme Web', path: '/w/acme-web' }]]);
    expect(projectLabel('acme-web-gr9brd', rows)).toEqual({ name: 'Acme Web', path: '/w/acme-web' });
    expect(projectLabel('studio-x-hut000', rows)).toEqual({ name: 'studio-x', path: null });
  });

  test('elapsed, zoom and address', () => {
    expect(elapsedParts(65 * 60_000 + 30_000)).toEqual({ h: 1, m: 5 });
    expect(screenZoom(1920)).toBe(1.45);
    expect(screenZoom(800)).toBe(1);
    expect(screenZoom(3840)).toBe(2);
    // Fit by both sides: the PC's ultrawide is held by its height, not stretched by its width.
    expect(screenZoom(1920, 1080)).toBe(1.45);
    expect(screenZoom(3440, 1440)).toBe(1.9);
    expect(screenZoom(3840, 2160)).toBe(2);
    expect(loadScreenMachine('/schermo')).toBeNull();
    expect(loadScreenMachine('/schermo/pc-1')).toBe('pc-1');
    expect(loadScreenMachine('/lavori')).toBeUndefined();
  });
});
