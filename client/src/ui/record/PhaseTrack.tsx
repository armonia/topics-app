import { Check, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { PhaseModel } from './model';

function PhaseDot({ phase }: { phase: PhaseModel }) {
  if (phase.state === 'done') {
    return <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white"><Check size={14} strokeWidth={3} aria-hidden="true" /></span>;
  }
  if (phase.state === 'current') {
    return <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-white ring-4 ring-primary/20"><Zap size={13} aria-hidden="true" /></span>;
  }
  return <span className="inline-flex h-6 w-6 items-center justify-center"><span className="h-2 w-2 rounded-full bg-app-text-faint/60" /></span>;
}

/**
 * The stages a record goes through, for its type: done in green, the current
 * one in blue, the next ones quiet, each with its date when it has one. It
 * answers "where is this" before anything else on the page is read.
 * With `onOpenStep`, a stage that names a flow step leads to it; the others
 * stay plain, and the button's padding is cancelled by its margin so the row
 * does not shift.
 */
export function PhaseTrack({ label, phases, copy, onOpenStep, phone, bare, trailing }: {
  label: string;
  phases: PhaseModel[];
  copy: UiCopy;
  onOpenStep?: (stepId: string) => void;
  /** On a phone the strip is dots that fit the width, with the current step named under them. */
  phone?: boolean;
  /** Without the label at the left: the track sits under a title that already says what it is (the case sheet). */
  bare?: boolean;
  /** At the right end of the strip (the example tag). */
  trailing?: ReactNode;
}) {
  const stateWord = { done: copy.record.done, current: copy.record.current, todo: copy.record.toDo };
  if (phone) {
    // A closed case has no current step: it stands on its last done step («Passo 5 di 5»), never back on the first.
    const current = phases.findIndex((p) => p.state === 'current');
    const lastDone = phases.map((p) => p.state).lastIndexOf('done');
    const at = current >= 0 ? current : Math.max(0, lastDone);
    const here = phases[at];
    return (
      <div className="shrink-0 border-b border-app-border px-4 pb-3 pt-3.5">
        {/* Every step gets an equal share and a short connector, so six steps fit 390 px with no sideways scroll. */}
        <ol className="flex items-center" aria-label={label}>
          {phases.map((p, i) => {
            const next = phases[i + 1];
            const dot = <PhaseDot phase={p} />;
            return (
              <li key={p.id} className={clsx('flex items-center', next && 'min-w-0 flex-1')} aria-current={p.state === 'current' ? 'step' : undefined} data-tip={`${p.label}, ${stateWord[p.state]}`}>
                {onOpenStep && p.step ? (
                  <button
                    type="button"
                    onClick={() => onOpenStep(p.step!)}
                    aria-label={`${p.label}, ${stateWord[p.state]}`}
                    className="-m-1.5 shrink-0 rounded-full p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    {dot}
                  </button>
                ) : dot}
                {next && (
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'mx-1 h-0 min-w-0 flex-1 border-t-2',
                      p.state === 'done' ? 'border-emerald-600' : p.state === 'current' ? 'border-dashed border-primary' : 'border-dashed border-app-border-light',
                    )}
                  />
                )}
              </li>
            );
          })}
        </ol>
        {here && (
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-mini leading-4">
            <span className="text-app-text-tertiary">{copy.record.phaseOf(at + 1, phases.length)}</span>
            <span className="font-semibold uppercase tracking-[0.06em] text-primary dark:text-primary-dark">{here.label}</span>
            {here.date && <span className="text-app-text-tertiary">{here.date}</span>}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className={clsx('flex shrink-0 items-start gap-6 overflow-x-auto border-b border-app-border pb-3 pt-3.5', bare ? 'px-4' : 'px-5')}>
      {!bare && <span className="pt-1 text-prose text-app-text-tertiary">{label}</span>}
      <ol className="flex items-start" aria-label={label}>
        {phases.map((p, i) => {
          const next = phases[i + 1];
          const marker = (
            <>
              <div className="flex w-full items-center">
                <PhaseDot phase={p} />
                {next && (
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'mx-1 h-0 flex-1 border-t-2',
                      p.state === 'done' ? 'border-emerald-600' : p.state === 'current' ? 'border-dashed border-primary' : 'border-dashed border-app-border-light',
                    )}
                  />
                )}
              </div>
              <span className={clsx(
                'pr-2 text-mini font-semibold uppercase leading-4 tracking-[0.06em]',
                p.state === 'done' ? 'text-emerald-700 dark:text-emerald-400' : p.state === 'current' ? 'text-primary dark:text-primary-dark' : 'text-app-text-tertiary',
              )}>
                {p.label}
                {p.date && <span className="block font-medium">{p.date}</span>}
              </span>
            </>
          );
          const step = p.step;
          return (
            <li key={p.id} className="flex w-[148px] flex-col items-start gap-1.5" aria-current={p.state === 'current' ? 'step' : undefined} data-tip={stateWord[p.state]}>
              {onOpenStep && step ? (
                <button
                  type="button"
                  onClick={() => onOpenStep(step)}
                  data-tip={p.label}
                  className="-m-1 flex w-[calc(100%+0.5rem)] flex-col items-start gap-1.5 rounded-md p-1 text-left hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.06]"
                >
                  {marker}
                </button>
              ) : marker}
            </li>
          );
        })}
      </ol>
      {trailing && <span className="ml-auto shrink-0 pt-0.5">{trailing}</span>}
    </div>
  );
}
