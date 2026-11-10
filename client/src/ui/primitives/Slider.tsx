import type { KeyboardEvent, PointerEvent } from 'react';
import clsx from 'clsx';

/*
 * A range drawn by the layer: a rail filled up to a round knob. It is a
 * `role="slider"` (arrows, Page keys, Home and End move it; a drag with the
 * pointer, mouse or finger, sets it) and never an `<input type="range">`,
 * whose look belongs to the browser. Controlled: the value comes in as a
 * prop and every change goes out through `onChange`.
 */

const KNOB = 16;

export function Slider({ value, min, max, step = 1, onChange, label, valueText, disabled, title, className }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  /** Accessible name; the slider has no visible label of its own. */
  label: string;
  /** What a screen reader says for the value, when the bare number is not enough ("40%"). */
  valueText?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const span = max - min;
  const ratio = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0;

  /** Snaps to the step and keeps inside the bounds; reports only a real change. */
  const set = (raw: number) => {
    const snapped = min + Math.round((raw - min) / step) * step;
    const next = Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
    if (next !== value) onChange(next);
  };

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const travel = box.width - KNOB;
    if (travel <= 0) return;
    const at = Math.min(1, Math.max(0, (e.clientX - box.left - KNOB / 2) / travel));
    set(min + at * span);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const big = Math.max(step, Math.round(span / 10 / step) * step);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
    else if (e.key === 'PageUp') next = value + big;
    else if (e.key === 'PageDown') next = value - big;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    set(next);
  };

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      data-tip={title}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e);
      }}
      onPointerMove={(e) => {
        if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
      }}
      className={clsx(
        'group relative flex h-6 min-w-0 flex-1 touch-pan-y select-none items-center outline-none coarse:h-11',
        disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <span aria-hidden="true" className="relative block h-1.5 w-full rounded-full bg-[rgba(120,120,128,0.28)]">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `calc((100% - ${KNOB}px) * ${ratio} + ${KNOB / 2}px)` }}
        />
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow-[0_1px_3px_rgba(0,0,0,0.2)] group-focus-visible:ring-2 group-focus-visible:ring-primary/60 dark:border-[var(--border-input)]"
        style={{ left: `calc((100% - ${KNOB}px) * ${ratio})` }}
      />
    </div>
  );
}
