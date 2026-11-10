import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { Action } from '../types';

type Variant = 'primary' | 'confirm' | 'secondary' | 'ghost' | 'danger';

/*
 * `confirm` is emerald-700, not the emerald-500/80 of the Board's Approve: that
 * one measures 3.58:1 with white text at 12px, under AA. Same family, legible.
 */
const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover',
  confirm: 'bg-emerald-700 text-white hover:bg-emerald-800',
  secondary: 'bg-black/[0.05] text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]',
  ghost: 'text-app-text-secondary hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]',
  danger: 'text-rose-600 hover:bg-rose-500/10 dark:text-rose-400',
};

/*
 * A disabled control turns grey in both themes, whatever its variant: a faded
 * blue still reads as a primary button on a dark surface. No hover, so nothing
 * answers the pointer.
 */
const DISABLED_LOOK = 'cursor-default bg-black/[0.04] text-app-text-tertiary dark:bg-white/[0.05]';
const DISABLED = 'cursor-default opacity-45';

const SIZE = {
  sm: 'h-6 gap-1 px-2 text-mini',
  md: 'h-7 gap-1.5 px-2.5 text-prose',
  lg: 'h-9 gap-2 px-4 text-prose',
} as const;

export function Button({ variant = 'secondary', size = 'md', icon: Icon, trailing, onClick, title, className, children }: {
  variant?: Variant;
  size?: keyof typeof SIZE;
  icon?: LucideIcon;
  /** Something after the label, e.g. the key that triggers it. */
  trailing?: ReactNode;
  /** `false` draws the button disabled: the action is not available here. */
  onClick?: Action;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const disabled = onClick === false;
  /*
   * A disabled button that carries a reason stays reachable (`aria-disabled`,
   * not `disabled`): a native disabled control gets no pointer or focus events
   * in some browsers, so its tooltip never opened. On a device that can be
   * touched there is no hover, so the reason is also written under the button.
   */
  const explained = disabled && Boolean(title);
  const button = (
    <button
      type="button"
      onClick={onClick || undefined}
      disabled={disabled && !explained}
      aria-disabled={explained || undefined}
      data-tip={title}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        SIZE[size],
        disabled ? DISABLED_LOOK : VARIANT[variant],
        className,
      )}
    >
      {Icon && <Icon size={size === 'sm' ? 12 : 14} className="shrink-0" aria-hidden="true" />}
      {children}
      {trailing}
    </button>
  );
  if (!explained) return button;
  return (
    <span className="inline-flex shrink-0 flex-col items-start gap-0.5">
      {button}
      <span className="hidden max-w-[16rem] whitespace-normal text-mini leading-4 text-app-text-tertiary coarse:block">{title}</span>
    </span>
  );
}

/** A round 28px chrome control (search, new, notifications), `raised-control` like the product's. */
export function IconButton({ icon: Icon, label, onClick, pressed, children, className }: {
  icon: LucideIcon;
  label: string;
  /** `false` draws the button disabled: the action is not available here. */
  onClick?: Action;
  /** For a toggle (the sidebar): whether it is on. */
  pressed?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const disabled = onClick === false;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      onClick={onClick || undefined}
      disabled={disabled}
      className={clsx('raised-control relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-app-text transition-colors', disabled && DISABLED, className)}
    >
      <Icon size={15} aria-hidden="true" />
      {children}
    </button>
  );
}
