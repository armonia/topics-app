import type { ReactNode } from 'react';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Tone } from '../types';
import { TONE_CHIP } from '../tone';
import { ProgressBar, Spinner } from '../primitives/Progress';
import type { ConnectionKind, JobViewModel } from './model';
import { CONNECTION_ICON } from './icons';

/** How a program is reached, as a chip: the glyph of the way, its words. */
export function ConnectionChip({ kind, label, className }: { kind: ConnectionKind; label: string; className?: string }) {
  const Icon = CONNECTION_ICON[kind];
  return (
    <span className={clsx('inline-flex min-h-5 items-center gap-1 whitespace-nowrap rounded bg-sky-500/10 px-1.5 py-px text-mini leading-4 text-app-text dark:bg-sky-400/10', className)}>
      <Icon size={12} className="shrink-0 text-app-text-secondary" aria-hidden="true" />
      <span className="min-w-0">{label}</span>
    </span>
  );
}

/** A coloured tile with the initial of a program: its monogram. */
export function ProgramTile({ initial, color, size = 40 }: { initial: string; color: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: color, width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-lg text-body-lg font-semibold text-white"
    >
      {initial}
    </span>
  );
}

/** A status pill: a tinted chip with an optional glyph. */
export function StatePill({ tone, icon, children }: { tone: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={clsx('inline-flex min-h-5 items-center gap-1 whitespace-nowrap rounded-xl px-2 py-px text-mini leading-4', TONE_CHIP[tone])}>
      {icon}
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/**
 * A simulated piece of work under the control that started it: the bar while
 * it runs, the steps it has done, and, when a step failed, which one.
 */
export function JobProgress({ job, copy, className }: { job: JobViewModel; copy: UiCopy; className?: string }) {
  const c = copy.programs.common;
  const total = job.done.length + (job.current ? 1 : 0) + (job.status === 'failed' ? 1 : 0);
  return (
    <div role="status" aria-live="polite" className={clsx('rounded-lg border border-app-border bg-app-inset px-3 py-2.5', className)}>
      {job.status === 'running' && (
        <>
          <ProgressBar value={job.progress} label={job.title} detail={c.jobSteps(job.done.length, Math.max(total, job.done.length + 1))} />
          {job.current && (
            <p className="mt-2 flex items-center gap-1.5 text-mini text-app-text-secondary">
              <Spinner size={11} />
              {job.current}
            </p>
          )}
        </>
      )}
      {job.status === 'done' && (
        <p className="flex items-center gap-1.5 text-prose font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 size={14} aria-hidden="true" />
          {job.title}
          <span className="font-normal text-app-text-tertiary">· {c.jobDone}</span>
        </p>
      )}
      {job.status === 'failed' && (
        <p className="flex items-start gap-1.5 text-prose font-medium text-rose-600 dark:text-rose-400">
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {job.title}
            <span className="block font-normal text-app-text-secondary">{c.jobFailed}: {job.failed}</span>
          </span>
        </p>
      )}
      {job.done.length > 0 && job.status !== 'done' && (
        <ul className="mt-2 space-y-0.5 text-mini text-app-text-tertiary">
          {job.done.map((d) => <li key={d} className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-emerald-600" aria-hidden="true" />{d}</li>)}
        </ul>
      )}
    </div>
  );
}

export interface GridColumn {
  id: string;
  label: string;
  /** Preferred width in px: columns share the room in this proportion and shrink a little before the table scrolls. */
  width?: number;
}

export interface GridRow {
  id: string;
  cells: Record<string, ReactNode>;
  selected?: boolean;
  onOpen?: () => void;
}

const FLEX_MIN = 120;

/**
 * A table whose current row says so (`aria-selected`), so pressing it again
 * is understood as «already here». Same look as the kit's table; a row with
 * `onOpen` is pressable. One grid for the header and every row (rows are
 * subgrids): a sized column shrinks in a narrow place but never below its
 * longest word or widest pill; below that the table scrolls inside its frame.
 */
export function DataGrid({ columns, rows, ariaLabel, className }: { columns: GridColumn[]; rows: GridRow[]; ariaLabel: string; className?: string }) {
  // Widths are shares, as in the kit's table: the grid fills its frame and shrinks every column alike.
  const template = columns.map((c) => (c.width ? `minmax(min-content, ${c.width}fr)` : `minmax(${FLEX_MIN}px, 240fr)`)).join(' ');
  return (
    <div className={clsx('w-full min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface', className)}>
      <div role="table" aria-label={ariaLabel} style={{ gridTemplateColumns: template }} className="grid w-min min-w-full text-prose">
        <div role="row" className="col-span-full grid min-h-9 grid-cols-subgrid items-center border-b border-app-border bg-app-inset text-compact font-medium text-app-text-secondary">
          {columns.map((c) => <span key={c.id} role="columnheader" className="min-w-0 px-3 py-1 leading-tight [overflow-wrap:break-word]">{c.label}</span>)}
        </div>
        {rows.map((r) => (
          <div
            key={r.id}
            role="row"
            aria-selected={r.selected ?? false}
            tabIndex={r.onOpen ? 0 : undefined}
            onClick={r.onOpen}
            onKeyDown={r.onOpen ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                r.onOpen?.();
              }
            } : undefined}
            className={clsx(
              'col-span-full grid min-h-11 grid-cols-subgrid items-center border-b border-app-border last:border-b-0',
              r.selected ? 'bg-sky-500/[0.08]' : r.onOpen && 'hover:bg-app-hover',
              r.onOpen && 'cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
            )}
          >
            {columns.map((c) => <div key={c.id} role="cell" className="min-w-0 px-3 py-2 text-app-text [overflow-wrap:break-word]">{r.cells[c.id]}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}
