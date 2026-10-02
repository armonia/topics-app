import { useRef } from 'react';
import { segmentTarget } from './controlKeys';

/** A lucide icon, or anything with the same two props. */
type Glyph = React.ComponentType<{ size?: number; className?: string }>;

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** With an icon the label becomes the accessible name and the tooltip. */
  icon?: Glyph;
}

/**
 * Segmented: two or three choices in one row, the current one marked by an
 * indicator that slides under it.
 *
 * A `radiogroup` of `radio`s, with the checked radio as the only tab stop, the
 * way a native radio group behaves. The indicator moves on `control-slide`
 * (index.css), the shared token of a control that answers a click, so the
 * global reduced-motion rule stops it with everything else.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  testId,
  disabled = false,
  className = '',
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** `data-testid` on the group; each radio gets `${testId}-${value}`. */
  testId?: string;
  disabled?: boolean;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const count = options.length;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = segmentTarget(e.key, index, count);
    if (next === null) return;
    // Stopped here: inside a menu level ArrowLeft would otherwise close the
    // level, and the host's roving would move the focus away.
    e.preventDefault();
    e.stopPropagation();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={`relative grid flex-shrink-0 rounded-md bg-black/5 p-0.5 dark:bg-white/10 ${disabled ? 'opacity-40' : ''} ${className}`}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden="true"
        className="control-slide pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 rounded bg-app-bg shadow-sm ring-1 ring-black/5 dark:bg-white/15 dark:ring-white/10"
        style={{ width: `calc((100% - 4px) / ${count})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => {
        const checked = i === index;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={Icon ? o.label : undefined}
            title={Icon ? o.label : undefined}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            data-testid={testId ? `${testId}-${o.value}` : undefined}
            onClick={() => { if (!checked) onChange(o.value); }}
            className={`relative z-10 flex min-w-0 items-center justify-center gap-1 rounded px-2 py-0.5 text-mini coarse:min-h-11 coarse:text-compact focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
              checked ? 'text-app-text' : 'text-app-text-secondary hover:text-app-text'
            }`}
          >
            {Icon ? <Icon size={13} className="flex-shrink-0" /> : <span className="truncate">{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
