import type { ReactNode } from 'react';
import clsx from 'clsx';
import { pressable } from '../shell/pressable';

export interface TableColumnModel {
  id: string;
  label: string;
  /** Width in px when there is room; without it the column shares the free room. */
  width?: number;
  align?: 'left' | 'right';
}

export interface TableRowModel {
  id: string;
  cells: Record<string, ReactNode>;
  onOpen?: () => void;
  selected?: boolean;
  /** A row that is there but not current (archived, closed): drawn faint. */
  muted?: boolean;
}

/** A free column never gets narrower than this while the table fits its place. */
const FLEX_MIN = 140;
/** The share a free column asks for, in the same unit as a sized column's width. */
const FLEX_WEIGHT = 240;

/**
 * A table of rows, the look of the Data tables: a tinted header, hairlines,
 * one CSS grid for the header and every row (rows are subgrids, so a column
 * is as wide in every row). A row with `onOpen` is pressable (Enter or Space,
 * a hover fill); the others are text.
 *
 * Sizing. The widths are shares: every column gets room in proportion to its
 * width (a free column as if it were 240 px), so the table always fills its
 * frame and a narrow place (a card beside a panel) takes from every column
 * alike, not from the long-text one first. No column goes below its longest
 * word or its widest pill: text wraps between words instead of ending in dots
 * (a clipped cell hid the fact the table was there to show) and instead of
 * breaking a word letter by letter. When even that does not fit (a phone), the
 * table scrolls sideways inside its own frame, never the page.
 */
export function Table({ columns, rows, empty, ariaLabel, dense, className }: {
  columns: TableColumnModel[];
  rows: TableRowModel[];
  /** Shown under the header when there are no rows. */
  empty?: ReactNode;
  ariaLabel: string;
  dense?: boolean;
  className?: string;
}) {
  const template = columns.map((c) => (c.width ? `minmax(min-content, ${c.width}fr)` : `minmax(${FLEX_MIN}px, ${FLEX_WEIGHT}fr)`)).join(' ');
  return (
    <div className={clsx('w-full min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface', className)}>
      {/* min-content wide at least: the sum of the columns' floors, so a narrow place scrolls instead of overlapping. */}
      <div role="table" aria-label={ariaLabel} style={{ gridTemplateColumns: template }} className="grid w-min min-w-full text-prose">
        <div role="rowgroup" className="col-span-full grid grid-cols-subgrid">
          <div
            role="row"
            className={clsx('col-span-full grid grid-cols-subgrid items-center border-b border-app-border bg-app-inset text-compact font-medium leading-tight text-app-text-secondary', dense ? 'min-h-8' : 'min-h-9')}
          >
            {columns.map((c) => (
              <span key={c.id} role="columnheader" className={clsx('min-w-0 px-3 py-1 [overflow-wrap:break-word]', c.align === 'right' && 'text-right')}>{c.label}</span>
            ))}
          </div>
        </div>
        <div role="rowgroup" className="col-span-full grid grid-cols-subgrid">
          {rows.map((r) => (
            <div
              key={r.id}
              role="row"
              data-selected={r.selected || undefined}
              aria-current={r.selected ? true : undefined}
              {...pressable(r.onOpen)}
              className={clsx(
                'col-span-full grid grid-cols-subgrid items-center border-b border-app-border last:border-b-0',
                dense ? 'min-h-8' : 'min-h-11',
                r.selected ? 'bg-sky-500/[0.08]' : r.onOpen && 'hover:bg-app-hover',
                r.onOpen && 'cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
                r.muted && 'text-app-text-tertiary',
              )}
            >
              {columns.map((c) => (
                <div
                  key={c.id}
                  role="cell"
                  className={clsx(
                    'min-w-0 px-3 [overflow-wrap:break-word]',
                    dense ? 'py-1' : 'py-2',
                    c.align === 'right' && 'text-right tabular-nums',
                    r.muted ? 'opacity-60' : 'text-app-text',
                  )}
                >
                  {r.cells[c.id]}
                </div>
              ))}
            </div>
          ))}
        </div>
        {rows.length === 0 && empty && <div className="col-span-full px-4 py-8 text-center text-prose text-app-text-tertiary">{empty}</div>}
      </div>
    </div>
  );
}
