import { Check } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { FOCUS_RING } from '../shell/pressable';

export type StepState = 'done' | 'current' | 'todo';

export interface StepperStepModel {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
}

/** The node of a step: a green tick behind, a blue ring now, a grey dot ahead. */
function Node({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span className="relative z-10 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500">
        <Check size={12} strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span className="relative z-10 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface ring-2 ring-primary">
        <span className="h-2 w-2 rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <span className="relative z-10 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-app-border-light bg-surface">
      <span className="h-1.5 w-1.5 rounded-full bg-black/20 dark:bg-white/25" />
    </span>
  );
}

const LABEL: Record<StepState, string> = {
  done: 'text-app-text-secondary',
  current: 'font-semibold text-app-text',
  todo: 'text-app-text-tertiary',
};

/**
 * The steps of a process and where it stands: done, the current one (marked
 * `aria-current="step"`), the ones ahead. Never by colour alone: each node has
 * its own shape, and with `copy` each step also says its state to a screen
 * reader. With `onOpen` every step is a button. Horizontal, the labels wrap
 * and it scrolls sideways inside itself only when even that does not fit.
 */
export function Stepper({ steps, onOpen, orientation = 'vertical', copy, ariaLabel, className }: {
  steps: StepperStepModel[];
  onOpen?: (id: string) => void;
  orientation?: 'vertical' | 'horizontal';
  /** Lets each step say its state to a screen reader (`copy.kit.stepper`). */
  copy?: UiCopy;
  ariaLabel?: string;
  className?: string;
}) {
  const horizontal = orientation === 'horizontal';
  return (
    <ol
      aria-label={ariaLabel ?? copy?.kit.stepper.label}
      className={clsx(horizontal ? 'scrollbar-none flex min-w-0 items-start overflow-x-auto px-0.5 py-1' : 'flex flex-col', className)}
    >
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const lineDone = s.state === 'done';
        const words = (
          <span className="min-w-0">
            <span className={clsx('block text-prose leading-5', horizontal && 'hyphens-auto [overflow-wrap:break-word]', LABEL[s.state])}>
              {s.label}
              {copy && <span className="sr-only">, {copy.kit.stepper[s.state]}</span>}
            </span>
            {s.detail && <span className={clsx('block text-mini leading-4 text-app-text-tertiary', horizontal && 'hyphens-auto [overflow-wrap:break-word]')}>{s.detail}</span>}
          </span>
        );
        const pressableClass = onOpen && clsx('rounded-lg text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]', FOCUS_RING);

        if (horizontal) {
          return (
            // Steps share the width in proportion to their label (64 px at least) and hyphenate only when that is not
            // enough: seven states fit a card beside a panel, where 120 px steps pushed the last ones off the edge.
            <li key={s.id} aria-current={s.state === 'current' ? 'step' : undefined} className="relative flex min-w-16 flex-auto flex-col gap-1.5">
              <div className="flex items-center">
                <Node state={s.state} />
                {!last && <span aria-hidden="true" className={clsx('mx-2 h-px flex-1', lineDone ? 'bg-emerald-500/70' : 'bg-app-border-light')} />}
              </div>
              {onOpen ? (
                <button type="button" onClick={() => onOpen(s.id)} className={clsx(pressableClass, '-mx-1 mr-3 px-1 py-0.5')}>{words}</button>
              ) : (
                <div className="pr-3">{words}</div>
              )}
            </li>
          );
        }
        return (
          <li key={s.id} aria-current={s.state === 'current' ? 'step' : undefined} className={clsx('relative flex gap-3', !last && 'pb-3')}>
            {!last && (
              <span aria-hidden="true" className={clsx('absolute bottom-0 left-[9.5px] top-[26px] w-px', lineDone ? 'bg-emerald-500/70' : 'bg-app-border-light')} />
            )}
            <span className="pt-1"><Node state={s.state} /></span>
            {onOpen ? (
              <button type="button" onClick={() => onOpen(s.id)} className={clsx(pressableClass, 'min-w-0 flex-1 px-2 py-1')}>{words}</button>
            ) : (
              <div className="min-w-0 flex-1 px-2 py-1">{words}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
