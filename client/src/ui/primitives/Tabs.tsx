import type { KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { Count } from './Chip';
import { FOCUS_RING } from '../shell/pressable';

/**
 * The section tabs of a pane: words on one line over a hairline, the current
 * one underlined in the primary colour. The value is the caller's; arrows,
 * Home and End move to the next tab and select it, as a tab list does. Many
 * tabs scroll sideways inside the strip, never the page.
 */
export function Tabs<T extends string>({ value, options, onChange, ariaLabel, className }: {
  value: T;
  options: Array<{ value: T; label: string; count?: number; icon?: LucideIcon }>;
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % options.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0 || !options.length) return;
    e.preventDefault();
    onChange(options[next].value);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={clsx('scrollbar-none flex min-w-0 items-stretch gap-5 overflow-x-auto border-b border-app-border', className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={clsx(
              'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-t-md text-prose font-medium transition-colors duration-fast',
              FOCUS_RING, 'focus-visible:ring-inset',
              on ? 'text-app-text' : 'text-app-text-secondary hover:text-app-text',
            )}
          >
            {Icon && <Icon size={14} className={on ? 'text-app-text' : 'text-app-text-tertiary'} aria-hidden="true" />}
            {o.label}
            {o.count !== undefined && <Count value={o.count} tone={on ? 'blue' : 'neutral'} />}
            <span
              aria-hidden="true"
              className={clsx('absolute inset-x-0 bottom-0 h-0.5 rounded-full transition-colors duration-fast', on ? 'bg-primary' : 'bg-transparent')}
            />
          </button>
        );
      })}
    </div>
  );
}
