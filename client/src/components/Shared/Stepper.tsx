import { Minus, Plus } from 'lucide-react';
import { stepperValue, type StepperRange } from './controlKeys';
import { useT } from '../../hooks/useT';

/**
 * Stepper: a number moved one step at a time, minus and plus around it.
 *
 * The focusable element is the value itself, a `spinbutton`: right and left
 * move it (up and down are the menu's, to the next row), and the two buttons are for the pointer and the finger, not tab stops
 * (still named, for whoever reaches them by pointer with a screen reader).
 * The number changes without animation: a number that rolls reads worse than
 * one that is simply there.
 */
export function Stepper({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  format = String,
  testId,
}: StepperRange & {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  /** How the value is written, and read aloud (`aria-valuetext`). */
  format?: (value: number) => string;
  /** `data-testid` on the spinbutton; the buttons get `-down` and `-up`. */
  testId?: string;
}) {
  const tr = useT();
  const range = { min, max, step };
  const set = (next: number | null) => {
    if (next !== null && next !== value) onChange(next);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = stepperValue(e.key, value, range);
    if (next === null) return;
    // The spinbutton owns the keys it moves on: the menu around it must not rove away.
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };
  const button = 'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-30 coarse:h-11 coarse:w-11';
  const text = format(value);

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5">
      <button
        type="button"
        tabIndex={-1}
        data-roving-skip=""
        aria-label={tr('stepper.decrease', { name: ariaLabel })}
        disabled={value <= min}
        data-testid={testId ? `${testId}-down` : undefined}
        onClick={() => set(stepperValue('ArrowLeft', value, range))}
        className={button}
      >
        <Minus size={12} />
      </button>
      <span
        role="spinbutton"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={text}
        data-testid={testId}
        onKeyDown={onKeyDown}
        className="min-w-[4.5rem] rounded px-1 text-center text-mini tabular-nums text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 coarse:flex coarse:min-h-11 coarse:items-center coarse:justify-center coarse:text-compact"
      >
        {text}
      </span>
      <button
        type="button"
        tabIndex={-1}
        data-roving-skip=""
        aria-label={tr('stepper.increase', { name: ariaLabel })}
        disabled={value >= max}
        data-testid={testId ? `${testId}-up` : undefined}
        onClick={() => set(stepperValue('ArrowRight', value, range))}
        className={button}
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
