/**
 * The board's «columns» preference: the status columns side by side
 * (`split`, today's board) or ONE merged column per leaf (`single`), where
 * every status shares the list and each card carries its status as a chip.
 * With the board grouped by project, `single` IS the stacked project cards:
 * one card per project holding one column of its tasks.
 */
import type { WorkflowColumn } from '../../../../shared/workflow';

export const COLUMNS_MODES = ['split', 'single'] as const;
export type ColumnsMode = (typeof COLUMNS_MODES)[number];

/** The id the merged column carries (it is no workflow column, so no status id can clash with it). */
export const MERGED_COLUMN_ID = 'merged';

/** The stand-in the pane hands `renderColumn` for the merged column; its `base` is never read there. */
export const MERGED_COLUMN: WorkflowColumn = { id: MERGED_COLUMN_ID, label: '', base: 'todo' };

/** Anything that is not a known mode reads as the board people already know. */
export function parseColumnsMode(raw: string | null | undefined): ColumnsMode {
  return raw === 'single' ? 'single' : 'split';
}

/** The views that have status columns to merge; the cards view and the workflow view have none. */
export function viewHasColumns(detail: string): boolean {
  return detail === 'grid' || detail === 'list';
}

/**
 * The tasks of the shown columns as ONE list: by workflow column order, then
 * the board's own order inside each column (`byColumn` is already sorted).
 * `ids` narrows it to a group's tasks.
 */
export function mergeInColumnOrder<T extends { id: string }>(
  columns: readonly Pick<WorkflowColumn, 'id'>[],
  byColumn: ReadonlyMap<string, readonly T[]>,
  ids?: ReadonlySet<string>,
): T[] {
  const merged: T[] = [];
  for (const column of columns) {
    for (const task of byColumn.get(column.id) ?? []) {
      if (!ids || ids.has(task.id)) merged.push(task);
    }
  }
  return merged;
}
