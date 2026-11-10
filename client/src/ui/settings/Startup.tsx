import { Check, Circle, CircleDashed, Loader, Repeat } from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Chip } from '../primitives/Chip';
import { Checkbox } from '../primitives/Field';
import { FOCUS_RING } from '../shell/pressable';
import type { Tone } from '../types';

export type StartupState = 'done' | 'current' | 'next' | 'later' | 'always';

export interface StartupStepModel {
  id: string;
  number: number;
  state: StartupState;
  stateLabel: string;
  title: string;
  text: string;
  /** When: the weeks, or the day it was done. */
  when: string;
  /** «3 di 5» tasks, quiet. */
  progress?: string;
  selected: boolean;
  onSelect: () => void;
}

const STATE_TONE: Record<StartupState, Tone> = { done: 'green', current: 'blue', next: 'neutral', later: 'neutral', always: 'neutral' };
const STATE_ICON = { done: Check, current: Loader, next: Circle, later: CircleDashed, always: Repeat } as const;

/** The steps of the start-up in order, on a line: done, the current one lit, the rest to come. */
export function StartupSteps({ steps, ariaLabel }: { steps: StartupStepModel[]; ariaLabel: string }) {
  return (
    <ol aria-label={ariaLabel} className="flex min-w-0 flex-col">
      {steps.map((s, i) => {
        const Icon = STATE_ICON[s.state];
        const last = i === steps.length - 1;
        return (
          <li key={s.id} className="relative flex gap-3">
            {!last && <span aria-hidden="true" className="absolute bottom-0 left-[13.5px] top-8 w-px bg-app-border-light" />}
            <span
              aria-hidden="true"
              className={clsx(
                'relative mt-3 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-compact font-semibold',
                s.state === 'done' && 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                s.state === 'current' && 'border-primary bg-primary text-white',
                s.state !== 'done' && s.state !== 'current' && 'border-app-border bg-surface text-app-text-secondary',
              )}
            >
              {s.state === 'done' ? <Check size={14} strokeWidth={2.5} /> : s.number}
            </span>
            <button
              type="button"
              aria-current={s.selected ? 'step' : undefined}
              onClick={s.onSelect}
              className={clsx(
                'mb-2 flex min-w-0 flex-1 flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
                FOCUS_RING,
                s.selected ? 'border-primary bg-surface ring-1 ring-primary' : 'border-app-border bg-surface hover:border-app-border-light hover:bg-app-hover',
              )}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Chip tone={STATE_TONE[s.state]} icon={Icon}>{s.stateLabel}</Chip>
                <span className="min-w-0 flex-1 text-prose font-semibold text-app-text">{s.number} · {s.title}</span>
                <span className="shrink-0 text-compact text-app-text-tertiary">{s.when}</span>
              </span>
              <span className="text-compact leading-4 text-app-text-secondary">{s.text}</span>
              {s.progress && <span className="text-mini tabular-nums text-app-text-tertiary">{s.progress}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A bar of equal ticks, the way the start-up shows how far the mapping went. */
export function Ticks({ value, total = 30, label }: { value: number; total?: number; label: string }) {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * total);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} className="flex h-3 gap-[2px]">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={clsx('h-full flex-1 rounded-[2px]', i < filled ? 'bg-primary' : 'bg-black/[0.08] dark:bg-white/[0.12]')} />
      ))}
    </div>
  );
}

export interface TaskModel {
  id: string;
  label: string;
  done: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
}

/** The things to do in a step, each one a tick box. */
export function TaskList({ tasks }: { tasks: TaskModel[] }) {
  return (
    <ul className="flex flex-col">
      {tasks.map((t) => (
        <li key={t.id}>
          <Checkbox checked={t.done} onChange={t.onToggle} label={t.label} disabled={t.disabled} title={t.title} />
        </li>
      ))}
    </ul>
  );
}

/** A facts row of the panel: a name and its value. */
export function Fact({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3 py-0.5 text-prose leading-5">
      <span className="min-w-0 flex-1 text-app-text">{label}</span>
      <span className="shrink-0 text-right font-medium tabular-nums text-app-text">{value}</span>
    </div>
  );
}
