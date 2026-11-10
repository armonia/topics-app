import clsx from 'clsx';

const FILL = {
  blue: 'bg-primary',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
} as const;

/**
 * How far a piece of work has gone: an optional line of words (what, and how
 * much in the caller's terms) over a thin bar. `value` runs from 0 to 1 and is
 * clamped, so a job that overshoots never draws past the end.
 */
export function ProgressBar({ value, tone = 'blue', label, detail, className }: {
  value: number;
  tone?: keyof typeof FILL;
  label?: string;
  /** The amount in words, e.g. `3 di 5 passi`, also read by a screen reader. */
  detail?: string;
  className?: string;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100);
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      {(label || detail) && (
        <div className="flex min-w-0 items-baseline gap-3 text-mini leading-4">
          {label && <span className="min-w-0 flex-1 truncate font-medium text-app-text">{label}</span>}
          {detail && <span className="ml-auto shrink-0 tabular-nums text-app-text-tertiary">{detail}</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={detail}
        aria-label={label}
        className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.10]"
      >
        <div style={{ width: `${pct}%` }} className={clsx('h-full rounded-full transition-[width] duration-base', FILL[tone])} />
      </div>
    </div>
  );
}

/**
 * A ring that turns while something loads (CSS only). Without `label` it is
 * decoration next to words that already say it; with one it announces itself.
 */
export function Spinner({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, borderWidth: size >= 20 ? 2.5 : 2 }}
      className={clsx('inline-block shrink-0 animate-spin rounded-full border-app-spinner border-t-primary', className)}
    />
  );
}
