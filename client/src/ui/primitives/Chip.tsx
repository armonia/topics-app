import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { FieldRef, Tone } from '../types';
import { TONE_CHIP, TONE_TEXT } from '../tone';
import { FIELD_ICON, FIELD_TONE } from '../icons';

/**
 * The chip of the Board cards: 20px tall, 11px text, a 15% fill of its tone.
 * `strong` raises the weight for a chip that names an actor.
 */
export function Chip({ tone = 'neutral', icon: Icon, strong, title, className, children }: {
  tone?: Tone;
  icon?: LucideIcon;
  strong?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-tip={title}
      className={clsx(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-mini leading-4',
        strong && 'font-medium',
        TONE_CHIP[tone],
        className,
      )}
    >
      {Icon && <Icon size={12} className="shrink-0" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * A named piece of data (`PEC.mittente`, `Scadenza ×2`): a neutral chip whose
 * glyph carries the kind in its own tint, so a column of chips is scanned by
 * kind first and read second.
 */
export function FieldChip({ field, className }: { field: FieldRef; className?: string }) {
  const Icon = FIELD_ICON[field.kind];
  return (
    <span className={clsx('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded bg-black/[0.05] px-1.5 text-mini leading-4 text-app-text dark:bg-white/10', className)}>
      <Icon size={12} className={clsx('shrink-0', TONE_TEXT[FIELD_TONE[field.kind]])} aria-hidden="true" />
      {/* Its own box so a long name ends in an ellipsis when the chip is given a max width; a short one draws as before. */}
      <span className="min-w-0 truncate">{field.name}</span>
    </span>
  );
}

/** A count in a small round badge, the one the sidebar rows carry. */
export function Count({ value, onFill, tone = 'neutral', className }: {
  value: number | string;
  onFill?: boolean;
  tone?: 'neutral' | 'blue' | 'red';
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-nano font-semibold leading-none tabular-nums',
        onFill ? 'bg-black/25 text-white' : tone === 'blue' ? 'bg-[#0a84ff] text-white' : tone === 'red' ? 'bg-rose-500 text-white' : 'bg-black/[0.07] text-app-text-secondary dark:bg-white/[0.12]',
        className,
      )}
    >
      {value}
    </span>
  );
}

/** A keyboard key, as the hints of the product print it. */
export function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-app-border-light bg-surface px-1 font-sans text-nano leading-none text-[var(--kbd-text)]">
      {children}
    </kbd>
  );
}
