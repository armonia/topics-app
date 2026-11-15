/** Pure helpers behind the remote-machine rows (Processes view). */
import type { MachineMoney, MachineSample } from '../../../shared/machine-overview';
import type { HistoryPoint } from './machineProcesses';

export function sampleSeries(samples: readonly MachineSample[], key: 'cpu' | 'mem' | 'disk'): HistoryPoint[] {
  return samples.flatMap((s) => (s[key] === null ? [] : [{ t: s.t, v: s[key] as number }]));
}

export function formatMoney(m: MachineMoney | null): string | null {
  if (!m) return null;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency }).format(m.amount); }
  catch { return `${m.amount.toFixed(2)} ${m.currency}`; }
}

/** «3 d 4 h», «5 h 10 min», «12 min». */
export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const min = Math.floor((sec % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${min} min`;
  return `${min} min`;
}
