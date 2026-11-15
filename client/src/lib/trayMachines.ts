/**
 * The tray's machine submenus: the words and numbers of each machine, from the
 * same overview the Processes view reads, so the two cannot tell different
 * stories. The shell only draws what this returns (`StatusMachine`, lib.rs).
 */
import type { MachineOverviewRow } from '../../../shared/machine-overview';
import { formatMoney, formatUptime } from './machineOverviewView';

/** One band of the machine card's dial: a percentage the machine measured, or null (band off). */
export interface TrayMetric {
  key: 'cpu' | 'mem' | 'disk';
  pct: number | null;
  /** 0 calm, 1 busy, 2 strained: the band's colour. */
  level: number;
  note: string;
}

export interface TrayMachine {
  id: string;
  title: string;
  lines: string[];
  spark: number[];
  /** The graphic card (`StatusMachine::card`, tray_machines.rs): the same one the Mac and the PC get. */
  name: string;
  badge: string;
  level: number;
  reason: string;
  local: boolean;
  metrics: TrayMetric[];
}

type Tr = (key: string, vars?: Record<string, string | number>) => string;

const KNOWN_REASONS = new Set(['not_paired', 'unreachable', 'not_a_node', 'powered_off', 'empty']);

// Amber and red per band, the same readings at which the usage service colours this computer
// and its own machines, so two cards side by side agree on what «full» means.
const LIMITS = { cpu: [85, 97], mem: [80, 92], disk: [85, 95] } as const;
const levelOf = (key: keyof typeof LIMITS, pct: number | null): number =>
  pct === null ? 0 : pct >= LIMITS[key][1] ? 2 : pct >= LIMITS[key][0] ? 1 : 0;
const gb = (n: number): string => `${n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 1 })} GB`;

export function trayMachines(rows: readonly MachineOverviewRow[], tr: Tr): TrayMachine[] {
  // A row that is not a node (an old name of this computer, a cloud target with no
  // machine behind it) has nothing to measure: the Processes view lists it, the tray does not.
  return rows.filter((m) => m.reason !== 'not_a_node').map((m) => {
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
    const pct = (v: number | null | undefined): number | null => (v == null ? null : Math.max(0, Math.min(100, Math.round(v))));
    const metrics: TrayMetric[] = k ? [
      { key: 'cpu', pct: pct(k.cpuPct), level: levelOf('cpu', pct(k.cpuPct)), note: k.cores ? tr('processes.remote.cores', { n: k.cores }) : '' },
      { key: 'mem', pct: pct(k.memPct), level: levelOf('mem', pct(k.memPct)), note: k.memUsedGB != null && k.memTotalGB ? `${gb(k.memUsedGB)} / ${gb(k.memTotalGB)}` : k.memTotalGB ? gb(k.memTotalGB) : '' },
      { key: 'disk', pct: pct(k.diskPct), level: levelOf('disk', pct(k.diskPct)), note: '' },
    ] : [];
    // The card's own tone says whether the machine answers, as the service's cards do; a full band colours itself only.
    const level = m.state === 'unreachable' ? 2 : m.state === 'live' && k?.rebootRequired && p ? 1 : 0;
    // The line under the dial: why it does not answer, else what it is and what it costs.
    const reason = m.state !== 'live'
      ? (lines[0] ?? '')
      : p && k?.rebootRequired ? tr('processes.remote.reboot')
      : p ? [p.providerLabel, p.serverType, formatMoney(p.monthly) ? `${formatMoney(p.monthly)} ${tr('processes.remote.month')}` : null].filter(Boolean).join(' · ')
      : '';
    return {
      id: m.id,
      title: [`${dot} ${m.name}`, m.state === 'live' ? null : state, ...gauges].filter(Boolean).join(' · '),
      lines,
      spark: m.history.flatMap((s) => (s.cpu === null ? [] : [s.cpu])),
      name: m.name,
      // lower case like the service's badges, so the cards read alike side by side
      badge: state.toLocaleLowerCase(),
      level,
      reason,
      local: m.local,
      metrics,
    };
  });
}
