import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { ProtectionState } from './model';
import type { Tone } from '../types';
import { Chip } from '../primitives/Chip';
import { FOCUS_RING } from '../shell/pressable';

export interface DeploymentModel {
  id: string;
  name: string;
  text: string;
  statusLabel: string;
  statusTone: Tone;
  /** The one on show (a radio), not necessarily the one that runs now. */
  selected: boolean;
  onSelect: () => void;
}

/** The places Topics can run: a radio card each, the state of each in a chip. */
export function DeploymentCards({ items, ariaLabel }: { items: DeploymentModel[]; ariaLabel: string }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid min-w-0 gap-3 sm:grid-cols-2">
      {items.map((d) => (
        <button
          key={d.id}
          type="button"
          role="radio"
          aria-checked={d.selected}
          onClick={d.onSelect}
          className={clsx(
            'flex min-w-0 flex-col gap-1.5 rounded-lg border px-3.5 py-3 text-left transition-colors',
            FOCUS_RING,
            d.selected ? 'border-primary bg-primary/[0.05] ring-1 ring-primary' : 'border-app-border bg-surface hover:border-app-border-light hover:bg-app-hover',
          )}
        >
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-prose font-semibold text-app-text">{d.name}</span>
            <Chip tone={d.statusTone}>{d.statusLabel}</Chip>
          </span>
          <span className="text-compact leading-4 text-app-text-secondary">{d.text}</span>
        </button>
      ))}
    </div>
  );
}

/** A comparison of what changes: a label on the left, the value for the place on show on the right. */
export function FactTable({ rows, ariaLabel }: { rows: Array<{ label: string; value: string }>; ariaLabel: string }) {
  return (
    <div role="list" aria-label={ariaLabel} className="flex flex-col">
      {rows.map((r) => (
        <div key={r.label} role="listitem" className="grid gap-x-4 gap-y-0.5 border-t border-app-border py-2 first:border-t-0 first:pt-0 sm:grid-cols-[180px_minmax(0,1fr)]">
          <span className="text-prose text-app-text-secondary">{r.label}</span>
          <span className="text-prose font-medium text-app-text">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

const STATE_TONE: Record<ProtectionState, Tone> = {
  on: 'green', 'to-enable': 'amber', 'to-evaluate': 'neutral', evaluating: 'blue', partial: 'amber', planned: 'neutral',
};

export interface ProtectionModel {
  id: string;
  name: string;
  how: string;
  state: ProtectionState;
  stateLabel: string;
  /** The button that moves it on, when there is one. */
  action?: ReactNode;
}

/** The protections as a checklist: what each one is, how it works, its state and what can be done about it. */
export function ProtectionList({ items, ariaLabel }: { items: ProtectionModel[]; ariaLabel: string }) {
  return (
    <ul aria-label={ariaLabel} className="overflow-hidden rounded-lg border border-app-border">
      {items.map((p) => (
        <li key={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-app-border px-3 py-2.5 last:border-b-0">
          <div className="min-w-[200px] flex-1">
            <div className="text-prose font-semibold leading-5 text-app-text">{p.name}</div>
            <div className="text-compact leading-4 text-app-text-secondary">{p.how}</div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Chip tone={STATE_TONE[p.state]}>{p.stateLabel}</Chip>
            {p.action}
          </div>
        </li>
      ))}
    </ul>
  );
}
