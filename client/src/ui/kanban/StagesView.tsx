import { Bot, ChevronRight, CirclePause, TriangleAlert, User } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { FOCUS_RING } from '../shell/pressable';
import type { FlowRowModel, ShareModel, StageCellModel, StageColumnModel } from './model';
import { StageIcon } from './parts';

/** Flow, five stages, stopped, who closed. */
const TABLE_COLUMNS = 'grid-cols-[minmax(190px,1.8fr)_repeat(5,minmax(92px,1fr))_5rem_minmax(130px,1.1fr)]';

/** Who closed the cards in «Fatto»: agents and people side by side in one bar. (allow-italian: quotes the Italian interface) */
export function ShareBar({ share, none, tip }: { share: ShareModel; none: string; tip?: string }) {
  const total = share.agent + share.person;
  const agentPct = total ? Math.round((share.agent / total) * 100) : 0;
  return (
    <div className="min-w-0" data-tip={tip}>
      {total === 0 ? (
        <p className="text-compact text-app-text-tertiary">{none}</p>
      ) : (
        <>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.08]" aria-hidden="true">
            <span style={{ width: `${agentPct}%` }} className="h-full bg-violet-500/80" />
            <span style={{ width: `${100 - agentPct}%` }} className="h-full bg-sky-500/70" />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-compact">
            <span className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-300"><Bot size={13} aria-hidden="true" />{share.agentLabel}</span>
            <span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-300"><User size={13} aria-hidden="true" />{share.personLabel}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** A count of zero is the same quiet dash as with every other empty cell of the app; a screen reader still hears the zero. */
function Count({ n }: { n: number }) {
  if (n === 0) {
    return (
      <span className="text-body-lg font-semibold text-app-text-tertiary">
        <span aria-hidden="true">-</span>
        <span className="sr-only">0</span>
      </span>
    );
  }
  return <span className="text-body-lg font-semibold tabular-nums text-app-text">{n}</span>;
}

/** What one stage of one flow says: how many, how long they wait, how many are stopped, whether work piles up. */
function CellFacts({ cell, count }: { cell: StageCellModel; count: number }) {
  return (
    <>
      <Count n={count} />
      {cell.wait && <span className="text-mini leading-4 text-app-text-secondary">{cell.wait}</span>}
      {cell.stuck > 0 && (
        <span className="inline-flex items-center gap-1 text-mini font-medium leading-4 text-amber-700 dark:text-amber-400">
          <CirclePause size={11} aria-hidden="true" />{cell.stuckLabel}
        </span>
      )}
      {cell.piles && (
        <span className="inline-flex items-center gap-1 text-mini font-medium leading-4 text-amber-800 dark:text-amber-300">
          <TriangleAlert size={11} aria-hidden="true" />{cell.pilesLabel}
        </span>
      )}
    </>
  );
}

const CELL_BOX = 'flex min-w-0 flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left';

function Cell({ cell, flow, onCell }: { cell: StageCellModel; flow: string | undefined; onCell: (flow: string | undefined, stage: string) => void }) {
  const piles = cell.piles ? 'bg-amber-500/[0.09] ring-1 ring-inset ring-amber-500/40 hover:bg-amber-500/[0.14]' : 'hover:bg-app-hover';
  if (cell.count === 0) return <div role="cell" className={clsx(CELL_BOX)}><CellFacts cell={cell} count={0} /></div>;
  return (
    <div role="cell" className="min-w-0">
      <button
        type="button"
        data-flow-cell={flow ?? 'all'}
        data-stage={cell.stage}
        aria-label={cell.label}
        data-tip={cell.pilesWhy}
        onClick={() => onCell(flow, cell.stage)}
        className={clsx(CELL_BOX, 'w-full transition-colors', piles, FOCUS_RING)}
      >
        <CellFacts cell={cell} count={cell.count} />
      </button>
    </div>
  );
}

function FlowHead({ row, onFlow }: { row: FlowRowModel; onFlow: (flow: string | undefined) => void }) {
  const Icon = row.icon;
  return (
    <button
      type="button"
      data-flow={row.flow ?? 'all'}
      aria-label={row.openLabel}
      onClick={() => onFlow(row.flow)}
      className={clsx('flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}
    >
      <Icon size={14} className="mt-0.5 shrink-0 text-app-text-secondary" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-prose font-semibold text-app-text">{row.label}</span>
        <span className="line-clamp-2 block text-mini leading-4 text-app-text-tertiary" data-tip={row.sub}>{row.sub}</span>
      </span>
    </button>
  );
}

function StuckCell({ row, onStuck }: { row: FlowRowModel; onStuck: (flow: string | undefined) => void }) {
  if (row.stuck === 0) {
    return (
      <span className="inline-block px-2 py-1.5 text-compact text-app-text-tertiary">
        <span aria-hidden="true">-</span>
        <span className="sr-only">0</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-flow-stuck={row.flow ?? 'all'}
      aria-label={row.stuckOpenLabel}
      onClick={() => onStuck(row.flow)}
      className={clsx('inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-compact font-medium tabular-nums text-amber-700 transition-colors hover:bg-app-hover dark:text-amber-400', FOCUS_RING)}
    >
      <CirclePause size={12} aria-hidden="true" />{row.stuckLabel}
    </button>
  );
}

/**
 * The flows against the stages: one row per flow and a last row for all of
 * them. Each cell says how many cards stand in that stage of that flow, how
 * long they wait there on average, how many are stopped and, tinted amber,
 * where the work of the row piles up; pressing a cell opens the list of
 * exactly those cards. The row name opens the cards of the flow, the stopped
 * column its stopped ones, and the last column says who closed the cards in
 * «Fatto» (allow-italian: quotes the Italian interface). On a phone every flow is a block of five rows,
 * so nothing scrolls sideways.
 */
export function FlowStageTable({ columns, rows, copy, phone, onCell, onFlow, onStuck }: {
  columns: StageColumnModel[];
  rows: FlowRowModel[];
  copy: UiCopy;
  phone?: boolean;
  onCell: (flow: string | undefined, stage: string) => void;
  onFlow: (flow: string | undefined) => void;
  onStuck: (flow: string | undefined) => void;
}) {
  const f = copy.kanban.stages;
  if (phone) {
    return (
      <div className="flex flex-col gap-3" aria-label={f.label} role="region">
        {rows.map((row) => (
          <section key={row.flow ?? 'all'} data-flow-block={row.flow ?? 'all'} className="overflow-hidden rounded-lg border border-app-border bg-surface">
            <div className="border-b border-app-border bg-app-inset px-1 py-0.5"><FlowHead row={row} onFlow={onFlow} /></div>
            <ul className="flex flex-col">
              {columns.map((c, i) => {
                const cell = row.cells[i];
                const body = (
                  <>
                    <StageIcon glyph={c.glyph} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-prose font-medium text-app-text">{c.label}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-mini leading-4 text-app-text-secondary">
                        {cell.wait && <span>{cell.wait}</span>}
                        {cell.stuck > 0 && <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400"><CirclePause size={11} aria-hidden="true" />{cell.stuckLabel}</span>}
                        {cell.piles && <span className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300"><TriangleAlert size={11} aria-hidden="true" />{cell.pilesLabel}</span>}
                      </span>
                    </span>
                    <Count n={cell.count} />
                    {cell.count > 0 && <ChevronRight size={15} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
                  </>
                );
                return (
                  <li key={c.id} className="border-t border-app-border first:border-t-0">
                    {cell.count > 0 ? (
                      <button
                        type="button"
                        data-flow-cell={row.flow ?? 'all'}
                        data-stage={c.id}
                        aria-label={cell.label}
                        data-tip={cell.pilesWhy}
                        onClick={() => onCell(row.flow, c.id)}
                        className={clsx('flex w-full items-center gap-2 px-3 py-2 text-left transition-colors', cell.piles ? 'bg-amber-500/[0.09] hover:bg-amber-500/[0.14]' : 'hover:bg-app-hover', FOCUS_RING, 'focus-visible:ring-inset')}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex w-full items-center gap-2 px-3 py-2">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-app-border px-3 py-2">
              <div className="flex items-center gap-1 text-compact text-app-text-secondary">{f.stuckColumn}: <StuckCell row={row} onStuck={onStuck} /></div>
              <div className="min-w-[8rem] flex-1"><ShareBar share={row.share} none={f.shareNone} tip={f.shareTip} /></div>
            </div>
          </section>
        ))}
      </div>
    );
  }
  /* The row of all flows is left out when one flow is all there is: it would repeat that flow. Then the stage names are plain headings. */
  const all = rows.find((r) => r.flow === undefined);
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface">
      <div role="table" aria-label={f.label} className="w-full min-w-[920px] text-prose">
        <div role="row" className={clsx('grid items-center gap-x-1 border-b border-app-border bg-app-inset px-1 py-1', TABLE_COLUMNS)}>
          <span role="columnheader" className="px-2 text-compact font-medium text-app-text-tertiary">{f.flowColumn}</span>
          {columns.map((c, i) => (
            <span key={c.id} role="columnheader" className="min-w-0">
              {all ? (
                <button
                  type="button"
                  data-stage-head={c.id}
                  aria-label={all.cells[i].label}
                  data-tip={c.hint}
                  onClick={() => onCell(undefined, c.id)}
                  className={clsx('inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg px-2 text-compact font-medium text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]', FOCUS_RING)}
                >
                  <StageIcon glyph={c.glyph} size={13} />
                  <span className="truncate">{c.label}</span>
                </button>
              ) : (
                <span data-stage-head={c.id} data-tip={c.hint} className="inline-flex h-7 max-w-full items-center gap-1.5 px-2 text-compact font-medium text-app-text-secondary">
                  <StageIcon glyph={c.glyph} size={13} />
                  <span className="truncate">{c.label}</span>
                </span>
              )}
            </span>
          ))}
          <span role="columnheader" className="px-2 text-compact font-medium text-app-text-tertiary">{f.stuckColumn}</span>
          <span role="columnheader" className="px-2 text-compact font-medium text-app-text-tertiary">{f.closedColumn}</span>
        </div>
        {rows.map((row, r) => (
          <div
            key={row.flow ?? 'all'}
            role="row"
            data-flow-row={row.flow ?? 'all'}
            className={clsx('grid items-start gap-x-1 px-1 py-1', TABLE_COLUMNS, r > 0 && 'border-t border-app-border', row.flow === undefined && 'border-t-2 bg-app-inset/60')}
          >
            <div role="rowheader" className="min-w-0"><FlowHead row={row} onFlow={onFlow} /></div>
            {row.cells.map((cell) => <Cell key={cell.stage} cell={cell} flow={row.flow} onCell={onCell} />)}
            <div role="cell" className="min-w-0 pt-0.5"><StuckCell row={row} onStuck={onStuck} /></div>
            <div role="cell" className="min-w-0 px-2 pt-2"><ShareBar share={row.share} none={f.shareNone} tip={f.shareTip} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
