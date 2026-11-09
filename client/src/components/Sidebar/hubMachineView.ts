/**
 * How a hub machine reads in the devices level: the dot's colour and the
 * second line. Apart from `HubMachineRows.tsx` so that file exports only
 * components (fast refresh).
 */
import { PALLINO_ATTESA, PALLINO_OK } from './chromeSignals';
import { formatMoney, type HubMachine } from '../../lib/hubMachines';

export type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** The dot: red over the cap or strained, amber busy, green on, grey off. */
export function hubMachineDot(m: HubMachine): string {
  if (m.level >= 2) return 'bg-red-600 dark:bg-red-400';
  const on = m.on ?? true;
  if (!on) return 'bg-app-text-muted/40';
  return m.level === 1 ? PALLINO_ATTESA : PALLINO_OK;
}

/** The second line: the spend on the cap when there is one, then what the hub says first. */
export function hubMachineDetail(m: HubMachine, tr: Tr, locale: string): string {
  const parts: string[] = [];
  if (m.spend) parts.push(tr('devices.hubSpend', { eur: formatMoney(m.spend.eur, locale), cap: Math.round(m.spend.cap) }));
  const first = m.lines?.[0] ?? m.caption ?? '';
  if (first) parts.push(first);
  return parts.join(' · ');
}

