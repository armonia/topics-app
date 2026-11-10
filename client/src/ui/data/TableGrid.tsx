import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, Clock, PanelRight } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Blank } from '../primitives/Blank';
import { Chip, FieldChip } from '../primitives/Chip';
import { FIELD_ICON, FIELD_TONE } from '../icons';
import { FOCUS_RING } from '../shell/pressable';
import { TONE_TEXT } from '../tone';
import type { CellModel, GridColumn, GridModel, GridRow, SortState } from './model';

function Cell({ cell, unread, badge, onOpen }: { cell: CellModel; unread?: boolean; badge?: string; onOpen?: () => void }) {
  switch (cell.kind) {
    case 'title':
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          {unread && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
          <span className={clsx('line-clamp-2 min-w-0 leading-4 [overflow-wrap:break-word] text-app-text', unread ? 'font-semibold' : 'font-medium')}>{cell.text}</span>
          {badge && <Chip tone="green" className="ml-1">{badge}</Chip>}
        </span>
      );
    case 'text': return <span className={clsx('block line-clamp-2 leading-4 tabular-nums [overflow-wrap:break-word]', cell.tone ? TONE_TEXT[cell.tone] : 'text-app-text')}>{cell.text}</span>;
    case 'status': return <Chip tone={cell.tone} icon={cell.waiting ? Clock : undefined}>{cell.text}</Chip>;
    case 'link':
      if (!onOpen) return <FieldChip field={cell.field} />;
      return (
        <button
          type="button"
          aria-label={cell.field.name}
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          onKeyDown={(e) => e.stopPropagation()}
          className={clsx('rounded underline-offset-2 transition-colors hover:underline', FOCUS_RING)}
        >
          <FieldChip field={cell.field} className="hover:bg-black/[0.09] dark:hover:bg-white/[0.16]" />
        </button>
      );
    case 'type': {
      const Icon = FIELD_ICON[cell.field];
      return (
        <span className={clsx('inline-flex items-center gap-1 text-compact font-medium', TONE_TEXT[FIELD_TONE[cell.field]])}>
          <Icon size={12} aria-hidden="true" />{cell.letter}
        </span>
      );
    }
    case 'empty': return <Blank />;
  }
}

function Box({ checked, label, onToggle, indeterminate }: { checked: boolean; label: string; onToggle?: () => void; indeterminate?: boolean }) {
  const box = clsx(
    'inline-flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors',
    checked || indeterminate ? 'border-primary bg-primary text-white' : 'border-black/25 bg-surface hover:border-primary dark:border-white/25',
  );
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
      onKeyDown={(e) => e.stopPropagation()}
      className={clsx(box, FOCUS_RING)}
    >
      {checked && <Check size={11} strokeWidth={3} aria-hidden="true" />}
      {!checked && indeterminate && <span aria-hidden="true" className="h-0.5 w-2 rounded bg-white" />}
    </button>
  );
}

/**
 * One grid for the header and every row (rows are subgrids). Widths are shares (a free column counts as 240), so the
 * table fills its frame and a narrow place takes from every column alike; no column goes below its longest word or
 * its widest pill: no word cut letter by letter, no pill over the next column. Below that the frame scrolls.
 */
const template = (columns: GridColumn[]) => ['40px', ...columns.map((c) => (c.width ? `minmax(min-content, ${c.width}fr)` : 'minmax(140px, 240fr)')), '40px'].join(' ');

/**
 * The live table of x01: a tick column, typed cells, rows grouped under a
 * quiet label, sortable headers (`aria-sort`), and at the end of each row a
 * button that shows the row in the side panel without leaving the table. A
 * row that has a record opens it; one that has none shows itself in the
 * panel. Wider than its place, it scrolls inside its own frame.
 */
export function TableGrid({ model, copy, sort, onSort, selectedIds, onToggleRow, onToggleAll, activeId, onOpenRow, onPeekRow, onOpenCell, empty }: {
  model: GridModel;
  copy: UiCopy;
  sort: SortState | null;
  onSort?: (col: string) => void;
  selectedIds: string[];
  onToggleRow?: (id: string) => void;
  onToggleAll?: () => void;
  /** The row shown in the side panel. */
  activeId?: string;
  onOpenRow?: (id: string) => void;
  onPeekRow?: (id: string) => void;
  onOpenCell?: (rowId: string, columnId: string) => void;
  /** Drawn under the header when no row is left. */
  empty?: ReactNode;
}) {
  const t = copy.dataMore.grid;
  const cols = template(model.columns);
  const all = model.groups.flatMap((g) => g.rows);
  const ticked = all.filter((r) => selectedIds.includes(r.id)).length;
  const press = (r: GridRow) => (r.opens ? onOpenRow : onPeekRow);
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface">
      <div role="table" aria-label={t.tableLabel} style={{ gridTemplateColumns: cols }} className="grid w-min min-w-full text-prose">
        <div role="row" className="col-span-full grid min-h-10 grid-cols-subgrid items-center border-b border-app-border bg-app-inset text-compact font-medium text-app-text-secondary">
          <span className="flex justify-center">
            <Box checked={all.length > 0 && ticked === all.length} indeterminate={ticked > 0 && ticked < all.length} label={t.selectAll} onToggle={onToggleAll} />
          </span>
          {model.columns.map((c) => {
            const on = sort?.col === c.id;
            return (
              <span key={c.id} role="columnheader" aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} className="min-w-0 pr-3">
                {c.sortable && onSort ? (
                  <button
                    type="button"
                    onClick={() => onSort(c.id)}
                    data-tip={t.sortBy(c.label)}
                    className={clsx('-ml-1 inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]', on && 'text-app-text', FOCUS_RING)}
                  >
                    <span className="whitespace-nowrap leading-tight">{c.label}</span>
                    {on && (sort.dir === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
                  </button>
                ) : <span className="whitespace-nowrap leading-tight">{c.label}</span>}
              </span>
            );
          })}
          <span />
        </div>
        {model.groups.map((g) => (
          <div key={g.id} role="rowgroup" className="col-span-full grid grid-cols-subgrid">
            {g.label && <div className="col-span-full flex h-8 items-center border-b border-app-border bg-app-inset px-3 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{g.label}</div>}
            {g.rows.map((r) => {
              const ticked = selectedIds.includes(r.id);
              const active = activeId === r.id;
              const open = press(r);
              return (
                <div
                  key={r.id}
                  role="row"
                  data-row={r.id}
                  aria-selected={active && !r.opens ? true : undefined}
                  tabIndex={open ? 0 : undefined}
                  onClick={open ? () => open(r.id) : undefined}
                  onKeyDown={open ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r.id); }
                  } : undefined}
                  className={clsx(
                    'col-span-full grid min-h-12 grid-cols-subgrid items-center border-b border-app-border last:border-b-0',
                    ticked ? 'bg-sky-500/[0.07]' : active ? 'bg-black/[0.03] dark:bg-white/[0.04]' : open && 'hover:bg-app-hover',
                    open && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
                  )}
                >
                  <span className="flex justify-center"><Box checked={ticked} label={t.selectRow} onToggle={onToggleRow ? () => onToggleRow(r.id) : undefined} /></span>
                  {model.columns.map((c) => (
                    <span key={c.id} role="cell" className="min-w-0 pr-3">
                      <Cell
                        cell={r.cells[c.id] ?? { kind: 'empty' }}
                        unread={r.unread}
                        badge={r.badge}
                        onOpen={onOpenCell && r.cells[c.id]?.kind === 'link' ? () => onOpenCell(r.id, c.id) : undefined}
                      />
                    </span>
                  ))}
                  <span className="flex justify-center">
                    {onPeekRow && (
                      <button
                        type="button"
                        aria-label={t.peek}
                        data-tip={t.peek}
                        aria-pressed={active}
                        onClick={(e) => { e.stopPropagation(); onPeekRow(r.id); }}
                        onKeyDown={(e) => e.stopPropagation()}
                        className={clsx(
                          'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                          active ? 'bg-black/[0.07] text-app-text dark:bg-white/[0.12]' : 'text-app-text-tertiary hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]',
                          FOCUS_RING,
                        )}
                      >
                        <PanelRight size={14} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {all.length === 0 && <div className="col-span-full">{empty}</div>}
      </div>
    </div>
  );
}
