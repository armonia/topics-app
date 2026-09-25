/**
 * "The Mac is 44% busy", coloured, with a bar under it. The headline of every
 * surface that talks about the machine's load: the board gauge popover, the
 * settings panel, the stop-N chip, night mode. One component so the words, the
 * rounding and the colour cannot drift apart between them (the number itself
 * is `machineBusyPct`, see `lib/machineBusy.ts`).
 *
 * The two axes it is made of are passed down to whoever wants to fold them
 * under a "Details" of their own: this line never names CPU or memory.
 */
import { useT, useActiveLocale } from '../../hooks/useT';
import { busyBarClass, busyTextClass, busyTone, pctPlaceholders, type MachineShares, machineBusyPct, machineMemPct } from '../../lib/machineBusy';

export function MachineBusyLine({ shares, bar = true, className = '' }: {
  shares: MachineShares | null | undefined;
  /** The thin bar under the sentence; off where the line sits in running text. */
  bar?: boolean;
  className?: string;
}) {
  const tr = useT();
  const locale = useActiveLocale();
  const pct = machineBusyPct(shares);
  const tone = busyTone(pct);
  return (
    <div className={className}>
      <p
        className={`text-compact font-semibold tabular-nums ${busyTextClass(tone)}`}
        data-testid="machine-busy-pct"
        data-tone={tone}
        data-pct={pct ?? ''}
      >
        {pct == null ? tr('machine.busyUnknown') : tr('machine.busy', pctPlaceholders(locale, { pct }))}
      </p>
      {bar && (
        <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <div className={`h-full rounded-full transition-[width] ${busyBarClass(tone)}`} style={{ width: `${pct ?? 0}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * The two axes behind the number, for a "Details" fold: "CPU 41% · memory 44%".
 * `n/a` for an axis that was not measured, never 0%.
 */
export function MachineAxesLine({ shares }: { shares: MachineShares | null | undefined }) {
  const tr = useT();
  const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? tr('machine.notMeasured') : `${Math.round(n)}%`);
  const mem = machineMemPct(shares);
  return (
    <p className="tabular-nums" data-testid="machine-busy-axes">
      {tr('machine.detailsAxes', { cpu: fmt(shares?.machineCpuPct), mem: fmt(mem) })}
    </p>
  );
}
