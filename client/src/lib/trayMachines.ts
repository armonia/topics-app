/**
 * The tray's machine submenus: the words and numbers of each machine, from the
 * same overview the Processes view reads, so the two cannot tell different
 * stories. The shell only draws what this returns (`StatusMachine`, lib.rs).
 */
import type { MachineOverviewRow } from '../../../shared/machine-overview';
import { formatMoney, formatUptime } from './machineOverviewView';

export interface TrayMachine {
  id: string;
  title: string;
  lines: string[];
  spark: number[];
}

type Tr = (key: string, vars?: Record<string, string | number>) => string;

const KNOWN_REASONS = new Set(['not_paired', 'unreachable', 'not_a_node', 'powered_off', 'empty']);

export function trayMachines(rows: readonly MachineOverviewRow[], tr: Tr): TrayMachine[] {
  return rows.map((m) => {
    const k = m.metrics;
    const state = m.state === 'live' ? tr('processes.remote.stateLive') : m.state === 'stopped' ? tr('processes.remote.stateStopped') : tr('processes.remote.stateUnreachable');
    const gauges = k ? [
      k.cpuPct === null ? null : `${tr('processes.cpu')} ${Math.round(k.cpuPct)}%`,
      k.memPct === null ? null : `${tr('processes.memory')} ${Math.round(k.memPct)}%`,
      k.diskPct === null ? null : `${tr('processes.disk')} ${Math.round(k.diskPct)}%`,
    ].filter(Boolean) : [];
    const dot = m.state === 'live' ? '●' : m.state === 'stopped' ? '○' : '▲';
    const p = m.provider;
    const lines = [
      m.state === 'live' ? null : m.reason === null ? null : KNOWN_REASONS.has(m.reason) ? tr(`processes.remote.r.${m.reason}`) : tr('processes.remote.r.other', { why: m.reason }),
      k?.uptimeSec != null ? `${tr('processes.remote.up')} ${formatUptime(k.uptimeSec)}` : null,
      p && formatMoney(p.monthly) ? `${tr('processes.remote.cost')} ${formatMoney(p.monthly)} ${tr('processes.remote.month')}` : null,
      p && formatMoney(p.spentThisMonth) ? `${tr('processes.remote.spent')} ${formatMoney(p.spentThisMonth)}` : null,
      p?.location ? `${tr('processes.remote.where')} ${p.location}` : null,
      p?.serverType ? `${tr('processes.remote.type')} ${p.serverType}` : null,
      p && k?.rebootRequired ? tr('processes.remote.reboot') : null,
    ].filter((l): l is string => l !== null);
    return {
      id: m.id,
      title: [`${dot} ${m.name}`, m.state === 'live' ? null : state, ...gauges].filter(Boolean).join(' · '),
      lines,
      spark: m.history.flatMap((s) => (s.cpu === null ? [] : [s.cpu])),
    };
  });
}
