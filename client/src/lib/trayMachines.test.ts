import { describe, expect, test } from 'bun:test';
import type { MachineOverviewRow } from '../../../shared/machine-overview';
import { trayMachines } from './trayMachines';

const tr = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(',')}` : key);
const base: MachineOverviewRow = { id: 'a', name: 'box', local: false, platform: 'linux', state: 'live', reason: null, metrics: { cpuPct: 12.4, memPct: 40, memUsedGB: 1, memTotalGB: 4, diskPct: 30, netInBps: null, netOutBps: null, uptimeSec: 3600, rebootRequired: true, cores: 2 }, history: [{ t: 1, cpu: 10, mem: 1, disk: 1 }, { t: 2, cpu: null, mem: 1, disk: 1 }], provider: null, providerError: null, at: 1 };

describe('trayMachines', () => {
  test('a live machine reads its gauges and its history', () => {
    const [m] = trayMachines([base], tr);
    expect(m.title).toBe('● box · processes.cpu 12% · processes.memory 40% · processes.disk 30%');
    expect(m.spark).toEqual([10]);
  });
  test('the cost and the pending restart appear only with a provider', () => {
    const own = trayMachines([base], tr)[0].lines.join('|');
    expect(own).not.toContain('cost');
    expect(own).not.toContain('reboot');
    const cloud = trayMachines([{ ...base, provider: { provider: 'x', providerLabel: 'X', monthly: { amount: 4, currency: 'EUR' }, spentThisMonth: null, location: 'Somewhere', serverType: null, createdAt: null } }], tr)[0].lines.join('|');
    expect(cloud).toContain('processes.remote.cost');
    expect(cloud).toContain('processes.remote.reboot');
  });
  test('a machine that does not answer carries the reason', () => {
    const [m] = trayMachines([{ ...base, state: 'unreachable', reason: 'unreachable', metrics: null }], tr);
    expect(m.title).toContain('processes.remote.stateUnreachable');
    expect(m.lines[0]).toBe('processes.remote.r.unreachable');
  });
});
