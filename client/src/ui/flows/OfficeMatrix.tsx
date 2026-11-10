import clsx from 'clsx';
import type { FieldRef } from '../types';
import type { UiCopy } from '../copy/types';
import { Card } from '../primitives/Card';
import { FieldChip } from '../primitives/Chip';
import { pressable } from '../shell/pressable';
import type { ActorModel } from './model';
import { ActorChip, OpensChip } from './FlowStep';

export interface OfficeCellModel {
  id: string;
  actor: ActorModel;
  title: string;
  /** The time a person has, e.g. `entro 4 h`. */
  due?: string;
  /** The view the step opens, as named. */
  opens?: string;
}

export interface OfficeRowModel {
  id: string;
  label: string;
  /** What the actor is: `regole e AI`, `avvocato interno`. */
  sub?: string;
  /** Cells by stage id; a stage may hold more than one step. */
  cells: Record<string, OfficeCellModel[]>;
}

export interface OfficeMatrixModel {
  phases: Array<{ id: string; label: string }>;
  rows: OfficeRowModel[];
  /** Example time per office, and where the flow waits longest. */
  times: Array<{ label: string; value: string }>;
  stuck?: string;
  passes: FieldRef[];
}

const LABEL_WIDTH = 150;
const PHASE_MIN = 150;

/**
 * A flow by who does what (w03): one row per actor (the system, a program, an
 * office), one column per stage, each step a card that opens its own page.
 * Under it, the time each office takes (an example), where the flow waits
 * longest, and the data that passes from one actor to another. Wider than its
 * place it scrolls inside its own frame.
 */
export function OfficeMatrix({ model, copy, onOpenStep, onOpenView, phone }: {
  model: OfficeMatrixModel;
  copy: UiCopy;
  onOpenStep: (stepId: string) => void;
  onOpenView: (stepId: string) => void;
  phone?: boolean;
}) {
  const t = copy.flowBuild.offices;
  const template = `${LABEL_WIDTH}px repeat(${model.phases.length}, minmax(${PHASE_MIN}px, 1fr))`;
  const minWidth = LABEL_WIDTH + PHASE_MIN * model.phases.length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="overflow-x-auto rounded-lg border border-app-border bg-surface">
        <div role="table" aria-label={t.tableLabel} style={{ minWidth }} className="text-prose">
          <div role="row" style={{ gridTemplateColumns: template }} className="grid h-9 items-center border-b border-app-border bg-app-inset text-compact font-medium text-app-text-secondary">
            <span role="columnheader" className="px-3">{t.who}</span>
            {model.phases.map((p) => <span key={p.id} role="columnheader" className="px-3">{p.label}</span>)}
          </div>
          {model.rows.map((r) => (
            <div key={r.id} role="row" style={{ gridTemplateColumns: template }} className="grid items-stretch border-b border-app-border last:border-b-0">
              <div role="rowheader" className="flex min-w-0 flex-col justify-center px-3 py-3">
                <span className="font-semibold text-app-text">{r.label}</span>
                {r.sub && <span className="text-compact text-app-text-tertiary">{r.sub}</span>}
              </div>
              {model.phases.map((p) => (
                <div key={p.id} role="cell" className="flex min-w-0 flex-col gap-2 px-2 py-2">
                  {(r.cells[p.id] ?? []).map((c) => (
                    <div
                      key={c.id}
                      {...pressable(() => onOpenStep(c.id))}
                      role="button"
                      className={clsx(
                        'min-w-0 cursor-pointer break-words rounded-lg border border-app-border bg-surface px-3 py-2 transition-colors',
                        'hover:border-primary/50 hover:bg-black/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.05]',
                      )}
                    >
                      <ActorChip actor={c.actor} copy={copy} />
                      <div className="mt-1 text-prose font-semibold leading-5 text-app-text">{c.title}</div>
                      {c.due && <div className="text-compact text-app-text-tertiary">{c.due}</div>}
                      {c.opens && <div className="mt-1.5 min-w-0"><OpensChip target={c.opens} copy={copy} link wrap onOpen={() => onOpenView(c.id)} /></div>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={clsx('mt-4 grid gap-3', phone ? 'grid-cols-1' : 'grid-cols-3')}>
        <Card title={t.timesTitle}>
          {model.times.length === 0 ? (
            <p>{t.noTimes}</p>
          ) : (
            <dl className="space-y-1">
              {model.times.map((x) => (
                <div key={x.label} className="flex items-baseline justify-between gap-3">
                  <dt>{x.label}</dt>
                  <dd className="font-semibold tabular-nums text-app-text">{x.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
        <Card title={t.stuckTitle}><p>{model.stuck ?? t.noStuck}</p></Card>
        <Card title={t.passesTitle}>
          {model.passes.length === 0 ? <p>{t.noPasses}</p> : <div className="flex flex-wrap gap-1.5">{model.passes.map((f) => <FieldChip key={f.name} field={f} />)}</div>}
        </Card>
      </div>
    </div>
  );
}
