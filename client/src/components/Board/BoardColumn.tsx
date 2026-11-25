/**
 * One column of the board, whichever kind: a status column (`Column`) or, in
 * the «Columns: one» mode, the merged column with every status. Kept apart
 * from `Card.tsx` so neither file imports the other's component.
 */
import type { WorkflowColumn } from '../../../../shared/workflow';
import { Column, type ColumnProps } from './Card';
import { MergedColumn } from './MergedColumn';

export type BoardColumnProps = ColumnProps & {
  /** Present = draw ONE merged column with these workflow columns as its chips; `tasks` are then all the statuses, in order. */
  merged?: readonly WorkflowColumn[];
};

export function BoardColumn({ merged, ...props }: BoardColumnProps) {
  if (!merged) return <Column {...props} />;
  return <MergedColumn {...props} columns={merged} />;
}
