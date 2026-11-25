/**
 * ONE column holding the tasks of every status («Columns: one»). Each card
 * says where it stands with a small status chip above it, since the column
 * header can no longer say it. Inside a project lane the lane's own card is
 * the frame; on the flat board the column draws its own, capped to the
 * reading width like the list view.
 *
 * Dragging is off here on purpose: a column that holds every status has no
 * target to move a card to, and reordering inside one mixed list would write an
 * order the split board never shows. A click still opens the card.
 */
import type { WorkflowColumn } from '../../../../shared/workflow';
import { columnOfTask } from '../../../../shared/workflow';
import { STATUS_LABEL, type BoardTask } from '../../lib/board';
import { StatusIcon } from './atoms';
import { Card, type ColumnProps } from './Card';
import { COLUMN_FRAME, COLUMN_WIDTH } from './boardGeometry';
import { DraftCard } from './DraftCard';
import { useCardRenderer } from './useCardRenderer';

/** A status column's props (the merged one ignores the ones that name a status or a drop target) plus the columns its chips name. */
export type MergedColumnProps = ColumnProps & { columns: readonly WorkflowColumn[] };

function StatusChip({ task, columns }: { task: BoardTask; columns: readonly WorkflowColumn[] }) {
  const column = columnOfTask(columns, task);
  const label = column && column.id !== column.base ? column.label : STATUS_LABEL[task.status];
  return (
    <span
      data-testid="merged-status-chip" data-status={task.status}
      className="mb-1 inline-flex items-center gap-1 rounded bg-black/5 dark:bg-white/10 px-1.5 text-mini leading-4 text-app-text-secondary"
    ><StatusIcon status={task.status} className="h-3 w-3" />{label}</span>
  );
}

export function MergedColumn({ tasks, columns, draft, inLane = false, ...input }: MergedColumnProps) {
  const renderCard = useCardRenderer({ ...input, dragDisabled: true }, Card);
  if (tasks.length === 0 && !draft) return null;
  return (
    <div
      data-testid="kanban-column-merged" data-lane-column={inLane || undefined}
      className={inLane ? 'flex flex-col' : `${COLUMN_FRAME} ${COLUMN_WIDTH.list}`}
    >
      <div className={`flex flex-col gap-2 ${inLane ? '' : 'px-2 py-2'}`}>
        {draft && <DraftCard draft={draft} />}
        {tasks.map((t) => (
          <div key={t.id} className="min-w-0">
            <StatusChip task={t} columns={columns} />
            {renderCard(t)}
          </div>
        ))}
      </div>
    </div>
  );
}
