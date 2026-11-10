import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { StandardStatus } from './model';
import { STANDARD_TONE } from './tones';
import { Chip } from '../primitives/Chip';
import { pressable } from '../shell/pressable';

export interface StandardRowModel {
  id: string;
  name: string;
  about: string;
  how: string;
  proof: string;
  status: StandardStatus;
  statusLabel: string;
  /** «verificata il 05/11», quiet, under the state: a labelled date, never a bare one. (allow-italian: quotes the Italian interface) */
  checked: string;
  selected: boolean;
  onOpen: () => void;
  /** The «verify now» button, in its own fixed column (every row is its own grid, so a sized track keeps the header aligned); null while the job runs. */
  action: ReactNode;
  /** The running job's progress bar, shown under the state in place of the date. */
  progress?: ReactNode;
}

export interface StandardGroupModel {
  id: string;
  label: string;
  rows: StandardRowModel[];
}

const GRID = 'lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1fr)_148px_120px] lg:gap-x-3';

/** The standards and laws, grouped; a row opens its card, and carries the control that verifies it. */
export function StandardList({ groups, labels, ariaLabel }: {
  groups: StandardGroupModel[];
  labels: { standard: string; how: string; proof: string; state: string };
  ariaLabel: string;
}) {
  return (
    <div role="table" aria-label={ariaLabel} className="overflow-hidden rounded-lg border border-app-border bg-surface">
      <div role="row" className={clsx('hidden border-b border-app-border bg-app-inset px-3 py-2 text-compact font-medium text-app-text-secondary', GRID)}>
        <span role="columnheader">{labels.standard}</span>
        <span role="columnheader">{labels.how}</span>
        <span role="columnheader">{labels.proof}</span>
        <span role="columnheader">{labels.state}</span>
        <span role="columnheader" aria-hidden="true" />
      </div>
      {groups.map((g) => (
        <div key={g.id} role="rowgroup">
          <div role="row" className="border-b border-app-border bg-black/[0.025] px-3 py-1.5 text-mini font-semibold uppercase tracking-[0.06em] text-app-text-tertiary dark:bg-white/[0.04]">
            {g.label}
          </div>
          {g.rows.map((r) => (
            <div
              key={r.id}
              role="row"
              aria-selected={r.selected}
              {...pressable(r.onOpen)}
              className={clsx(
                'flex cursor-pointer flex-col gap-1.5 border-b border-app-border px-3 py-2.5 text-prose leading-5 transition-colors last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
                GRID,
                r.selected ? 'bg-sky-500/[0.08]' : 'hover:bg-app-hover',
              )}
            >
              <div role="cell" className="min-w-0">
                <div className="font-semibold text-app-text">{r.name}</div>
                <div className="text-compact text-app-text-tertiary">{r.about}</div>
              </div>
              <div role="cell" className="min-w-0 text-compact leading-4 text-app-text-secondary">{r.how}</div>
              <div role="cell" className="min-w-0 text-compact leading-4 text-app-text-secondary">{r.proof}</div>
              <div role="cell" className="flex min-w-0 flex-col items-start gap-0.5">
                <Chip tone={STANDARD_TONE[r.status]}>{r.statusLabel}</Chip>
                {r.progress ?? <span className="text-mini text-app-text-tertiary">{r.checked}</span>}
              </div>
              <div role="cell" className="flex min-w-0 items-start justify-start lg:justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{r.action}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
