import { FileText, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Table } from '../primitives/Table';
import { FOCUS_RING } from '../shell/pressable';

export interface DocPointModel {
  id: string;
  /** The sentence of the summary. */
  text: string;
  /** What it is tied to: `p.5 r.12-18`, `decreto p.1`. */
  sourceLabel: string;
  page: number;
}

export interface DocFieldModel {
  id: string;
  label: string;
  value: string;
  sourceLabel: string;
}

const SOURCE_CHIP = 'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded bg-sky-500/10 px-1.5 text-mini font-medium leading-4 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300';

/**
 * The AI summary beside the original (v01): every sentence tied to its page,
 * so a click turns the original to the passage, and below it the values read
 * from the document, each with its source. `page` is the page on show: the
 * sentence that rests on it reads as current.
 */
export function DocSummary({ points, fields, page, copy, onOpenPoint, onOpenField, wide }: {
  points: DocPointModel[];
  fields: DocFieldModel[];
  page: number;
  copy: UiCopy;
  onOpenPoint?: (id: string) => void;
  onOpenField?: (id: string) => void;
  /** The summary has the whole width (no original beside it): fields get their own columns. */
  wide?: boolean;
}) {
  const d = copy.work.doc;
  const sources = new Set(points.map((p) => p.sourceLabel)).size;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 px-4 pb-1 pt-4">
        <Chip tone="pink" icon={Sparkles} strong>{copy.common.ai}</Chip>
        <h2 className="text-body-lg font-semibold text-app-text">{d.summary}</h2>
        <span className="ml-auto text-compact text-app-text-tertiary">{d.summaryCount(points.length, sources)}</span>
      </div>
      {points.length === 0 ? (
        <EmptyState icon={FileText} title={d.noSummary}>{d.noSummaryBody}</EmptyState>
      ) : (
        <ol className="px-2 py-2">
          {points.map((p, i) => {
            const on = p.page === page;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpenPoint?.(p.id)}
                  aria-current={on ? 'true' : undefined}
                  className={clsx('flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors', FOCUS_RING, on ? 'bg-sky-500/[0.08] ring-1 ring-sky-500/30' : 'hover:bg-app-hover')}
                >
                  <span className={clsx('mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-mini font-semibold tabular-nums', on ? 'bg-primary text-white' : 'bg-black/[0.07] text-app-text-secondary dark:bg-white/[0.12]')}>{i + 1}</span>
                  <span className="min-w-0 flex-1 text-body-lg leading-6 text-app-text">
                    {p.text}
                    <span className={clsx(SOURCE_CHIP, 'ml-1.5 align-[1px]')}><FileText size={12} aria-hidden="true" />{p.sourceLabel}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="border-t border-app-border px-4 pb-4 pt-4">
        <h3 className="mb-2 text-body-lg font-semibold text-app-text">{d.fields}</h3>
        {fields.length === 0 ? (
          <p className="text-prose text-app-text-secondary">{d.noFields}</p>
        ) : (
          <Table
            ariaLabel={d.fields}
            dense
            columns={wide ? [
              { id: 'label', label: d.colField, width: 220 },
              { id: 'value', label: d.colValue },
              { id: 'source', label: d.colSource, width: 200 },
            ] : [
              // Beside the original the pane is narrow: the source moves under the value so the value keeps the room.
              { id: 'label', label: d.colField, width: 110 },
              { id: 'value', label: d.colValue },
            ]}
            rows={fields.map((f) => {
              const source = <span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-300"><FileText size={12} aria-hidden="true" />{f.sourceLabel}</span>;
              return {
                id: f.id,
                onOpen: onOpenField ? () => onOpenField(f.id) : undefined,
                cells: {
                  label: <span className="text-app-text-secondary">{f.label}</span>,
                  value: wide
                    ? <span className="font-semibold text-app-text" data-tip={f.value}>{f.value}</span>
                    : <span className="flex flex-col items-start gap-0.5"><span className="font-semibold text-app-text" data-tip={f.value}>{f.value}</span><span className="text-compact">{source}</span></span>,
                  source,
                },
              };
            })}
          />
        )}
      </div>
    </div>
  );
}
