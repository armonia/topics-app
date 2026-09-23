import { formatShare, machineShare } from '../../lib/shell/heavyPanes';

/** The sentence under the title: what the page was taking of the Mac. */
export function pausedUsageText(
  tr: (key: string, vars?: Record<string, string | number>) => string,
  v: { cpu: number; memMb?: number },
  machine: { cores: number; memMb: number | null },
): string {
  const share = machineShare(v, machine);
  const cpu = formatShare(share.cpuPct);
  return share.memPct != null
    ? tr('browser.heavy.paused.bodyCpuMem', { cpu, mem: formatShare(share.memPct) })
    : tr('browser.heavy.paused.body', { cpu });
}
