import { formatShare, machineShare } from '../../lib/shell/heavyPanes';
import { busiestPct, pctVars } from '../../lib/machineBusy';

/**
 * The sentence under the title: how much of the Mac the page was taking, as
 * ONE percentage (24/09). It is the larger of its CPU share and its memory
 * share, the same rule as the machine's own number (`machineBusyPct`), so a
 * page that holds 20% of the RAM at 3% CPU says 20%, not 3%.
 */
export function pausedUsageText(
  tr: (key: string, vars?: Record<string, string | number>) => string,
  v: { cpu: number; memMb?: number },
  machine: { cores: number; memMb: number | null },
  locale: 'it' | 'en' = 'it',
): string {
  return tr('browser.heavy.paused.body', pctVars(locale, { pct: pageSharePct(v, machine) }));
}

/** The page's share of the Mac, 0-100, never rounded down to a flat zero. */
export function pageSharePct(v: { cpu: number; memMb?: number }, machine: { cores: number; memMb: number | null }): number {
  const share = machineShare(v, machine);
  const pct = busiestPct(share.cpuPct, share.memPct) ?? 0;
  // `formatShare` is the rule for "under 1%": keep it, a running page is never 0.
  return formatShare(pct) === '<1' ? 0.5 : pct;
}
