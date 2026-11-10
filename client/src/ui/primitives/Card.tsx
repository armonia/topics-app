import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { Tone } from '../types';
import { TONE_CHIP, TONE_TEXT } from '../tone';
import { FOCUS_RING, pressable } from '../shell/pressable';

const CARD = 'rounded-lg border border-app-border bg-surface';
const CARD_PRESSABLE = `cursor-pointer transition-colors hover:border-app-border-light hover:bg-black/[0.03] dark:hover:bg-white/[0.05] ${FOCUS_RING}`;

/** A tinted border for a card that carries a state, quiet enough to read through. */
const TONE_BORDER: Partial<Record<Tone, string>> = {
  blue: 'border-sky-500/35',
  green: 'border-emerald-500/35',
  amber: 'border-amber-500/45',
  red: 'border-rose-500/40',
  violet: 'border-violet-500/35',
  pink: 'border-fuchsia-500/35',
};

/**
 * A block of content on the surface: an optional head (a glyph in a tinted
 * tile, the title, actions on the right), then the body. With `onOpen` the
 * whole card is pressable; clicks on its actions stay theirs.
 */
export function Card({ title, icon: Icon, actions, children, onOpen, className, tone }: {
  title?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
  className?: string;
  /** Tints the glyph tile and the border, for a card that carries a state. */
  tone?: Tone;
}) {
  const head = title || Icon || actions;
  return (
    <section
      {...pressable(onOpen)}
      className={clsx(CARD, 'flex min-w-0 flex-col', tone && TONE_BORDER[tone], onOpen && CARD_PRESSABLE, className)}
    >
      {head && (
        <header className="flex min-w-0 items-center gap-2.5 px-3.5 pt-3">
          {Icon && (
            <span className={clsx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', TONE_CHIP[tone ?? 'neutral'])}>
              <Icon size={15} aria-hidden="true" />
            </span>
          )}
          {/* A long title wraps instead of ending in dots: on a phone the dots hid what the card was about. */}
          {title && <h3 className="min-w-0 flex-1 text-prose font-semibold leading-5 text-app-text [overflow-wrap:break-word]">{title}</h3>}
          {actions && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              {actions}
            </span>
          )}
        </header>
      )}
      <div className={clsx('min-w-0 px-3.5 pb-3.5 text-prose leading-5 text-app-text-secondary', head ? 'pt-2' : 'pt-3.5')}>{children}</div>
    </section>
  );
}

/**
 * One number that matters, the tile of the overview: the figure large, what
 * it counts under it, an optional quiet line. Both lines wrap rather than end
 * in «…»: a phone has no hover to read the rest. `tone` colours the figure.
 */
export function StatCard({ label, value, detail, tone, onOpen, className }: {
  label: string;
  value: ReactNode;
  detail?: string;
  tone?: Tone;
  onOpen?: () => void;
  className?: string;
}) {
  const body = (
    <>
      <div className={clsx('text-[26px] font-semibold leading-9 tracking-[-0.01em] tabular-nums', tone && tone !== 'neutral' ? TONE_TEXT[tone] : 'text-app-text')}>{value}</div>
      <div className="text-prose text-app-text-secondary [overflow-wrap:break-word]">{label}</div>
      {detail && <div className="mt-0.5 text-compact text-app-text-tertiary [overflow-wrap:break-word]">{detail}</div>}
    </>
  );
  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} className={clsx(CARD, CARD_PRESSABLE, 'block w-full min-w-0 px-4 py-3.5 text-left', className)}>
        {body}
      </button>
    );
  }
  return <div className={clsx(CARD, 'min-w-0 px-4 py-3.5', className)}>{body}</div>;
}
