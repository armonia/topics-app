/**
 * The board's TABLE view: every card one dense row, so the whole board reads
 * in a line each. One sticky header sorts (a click flips the column); with a
 * grouping on, each group is a block of rows under the same header and the
 * same grid template, so the cells line up across groups. A click on a row
 * opens the task drawer, like a card does.
 */
import { ArrowDown, ArrowUp, GitBranch, GitPullRequest, MessageSquare } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { WorkflowColumn } from '../../../../shared/workflow';
import { columnOfTask } from '../../../../shared/workflow';
import { useT } from '../../hooks/useT';
import { STATUS_LABEL, type BoardTask } from '../../lib/board';
import { StatusIcon } from './atoms';
import { taskWaitsOnPerson } from './boardLanes';
import { COLUMNS_ROW_LIST } from './boardGeometry';
import { DEFAULT_TABLE_SORT, nextTableSort, sortTableTasks, tableLayout, type TableSort, type TableSortKey } from './boardTableModel';
import type { GroupKey, GroupNode } from './boardGrouping';
import { PRIORITY_DOT, PRIORITY_LABEL } from './constants';
import { DraftCard } from './DraftCard';
import type { DraftPreview } from './draftPreview';
import { GroupedBoard } from './GroupedBoard';
import { ownerChip, ownerTone } from './ownerChip';
import { UpdatedAgo } from './UpdatedAgo';

/** A cell's box; `flex` (always shown) or the layout's `extra` (shown once the pane is wide) is added by the caller. */
const CELL = 'min-w-0 items-center gap-1.5 px-2';

export interface BoardTableProps {
  /** The cards the filters and the Done toggle let through, in board order. */
  tasks: readonly BoardTask[];
  columns: readonly WorkflowColumn[];
  /** The group tree, empty when the table is not grouped. */
  groups: readonly GroupNode[];
  levels: readonly GroupKey[];
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  nameById: ReadonlyMap<string, string>;
  pathById: ReadonlyMap<string, string>;
  labelOf: (level: GroupKey, key: string) => string;
  draftAbove?: DraftPreview;
  /** The global board shows the project of each card. */
  showProject: boolean;
  personName: string | null;
  onOpen: (id: string) => void;
}

/** The label a column carries: the plain statuses speak the app's own words, a stage its name. */
function columnLabel(column: WorkflowColumn): string {
  return column.id === column.base ? STATUS_LABEL[column.base] : column.label;
}

export function BoardTable({ tasks, columns, groups, levels, collapsed, onToggle, nameById, pathById, labelOf, draftAbove, showProject, personName, onOpen }: BoardTableProps) {
  const tr = useT();
  const [sort, setSort] = useState<TableSort>(DEFAULT_TABLE_SORT);
  const layout = tableLayout(showProject);
  const ctx = useMemo(
    () => ({ columns, personName, projectName: (id: string) => nameById.get(id) ?? id }),
    [columns, personName, nameById],
  );
  const grouped = levels.length > 0;
  const sortedAll = useMemo(() => (grouped ? [] : sortTableTasks(tasks, sort, ctx)), [grouped, tasks, sort, ctx]);

  const header = (key: TableSortKey, label: string, extra: boolean) => {
    const on = sort.key === key;
    return (
      <div role={grouped ? undefined : 'columnheader'} aria-sort={grouped ? undefined : on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`min-w-0 ${extra ? layout.extra : 'flex'}`}>
        <button
          type="button" data-testid={`board-table-sort-${key}`} onClick={() => setSort((s) => nextTableSort(s, key))}
          title={tr('board.table.sortBy', { col: label })}
          className={`flex h-7 min-w-0 flex-1 items-center gap-1 px-2 text-left text-mini font-medium hover:bg-black/5 dark:hover:bg-white/5 ${on ? 'text-app-text' : 'text-app-text-secondary'}`}
        >
          <span className="truncate">{label}</span>
          {on && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0" aria-hidden="true" /> : <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />)}
        </button>
      </div>
    );
  };

  const row = (task: BoardTask): ReactNode => {
    const column = columnOfTask(columns as WorkflowColumn[], task);
    const chip = ownerChip(task, tr, personName);
    const ownerName = chip.label || tr(`board.owner.${chip.kind}`);
    const waits = taskWaitsOnPerson(task);
    const prUrl = task.checksCi?.prUrl;
    // A div, not a button: a button's children are presentational, so its cells would vanish for a screen reader, and `row` is no role a button may take.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(task.id); } };
    return (
      <div
        key={task.id} role="row" tabIndex={0} data-testid="board-table-row" data-task-id={task.id} data-status={task.status}
        onClick={() => onOpen(task.id)} onKeyDown={onKey}
        className={`grid h-8 w-full cursor-pointer items-center text-left text-compact leading-4 text-app-text hover:bg-black/5 dark:hover:bg-white/5 ${layout.grid}`}
      >
        <span role="cell" className={`flex ${CELL}`} title={column ? columnLabel(column) : task.status}>
          <StatusIcon status={task.status} />
          <span className="truncate text-app-text-secondary">{column ? columnLabel(column) : STATUS_LABEL[task.status]}</span>
        </span>
        <span role="cell" className={`flex ${CELL}`} title={task.text}>
          {waits && <span data-testid="board-table-waiting" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title={tr('board.table.waitsOnYou')} />}
          <span className="truncate">{task.text}</span>
        </span>
        {showProject && <span role="cell" className={`${CELL} ${layout.extra} text-app-text-secondary`} title={nameById.get(task.projectId) ?? task.projectId}>
          <span className="truncate">{nameById.get(task.projectId) ?? task.projectId}</span>
        </span>}
        <span role="cell" className={`${CELL} ${layout.extra}`} title={chip.title}>
          <span className={`min-w-0 truncate rounded px-1.5 text-mini leading-4 ${ownerTone(chip.key)}`}>{ownerName}</span>
        </span>
        <span role="cell" className={`${CELL} ${layout.extra} text-app-text-secondary`} title={PRIORITY_LABEL[task.priority] ?? String(task.priority)}>
          <span className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
          <span className="truncate">{PRIORITY_LABEL[task.priority] ?? task.priority}</span>
        </span>
        <span role="cell" className={`flex ${CELL} whitespace-nowrap text-mini text-app-text-secondary`} title={new Date(task.updatedAt).toLocaleString()}>
          <UpdatedAgo iso={task.updatedAt} />
        </span>
        <span role="cell" className={`${CELL} ${layout.extra} text-app-text-secondary`}>
          {task.assignedTopicId && <span title={tr('board.table.chat')}><MessageSquare className="h-3.5 w-3.5" aria-label={tr('board.table.chat')} /></span>}
          {task.deliveryBranch && <span title={task.deliveryBranch}><GitBranch className="h-3.5 w-3.5" aria-label={task.deliveryBranch} /></span>}
          {prUrl && <span title={tr('board.table.pr')}><GitPullRequest className="h-3.5 w-3.5" aria-label={tr('board.table.pr')} /></span>}
        </span>
      </div>
    );
  };

  // Grouped, each leaf is its own table (the group headers between them are no rows); flat, ONE table holds the header and the rows.
  // An empty leaf (the composer's ghost lane) draws nothing rather than an empty bordered box.
  const rows = (list: readonly BoardTask[], label?: string): ReactNode => list.length === 0 ? null : (
    <div role={grouped ? 'table' : 'rowgroup'} aria-label={label} className="flex flex-col divide-y divide-app-border overflow-hidden rounded border border-app-border bg-surface">
      {list.map(row)}
    </div>
  );
  const renderLeaf = (node: GroupNode) => rows(sortTableTasks(node.tasks, sort, ctx), tr('board.view.table'));

  return (
    <div data-testid="board-table" role={grouped ? undefined : 'table'} aria-label={grouped ? undefined : tr('board.view.table')} className={`${COLUMNS_ROW_LIST} @container`}>
      <div role={grouped ? undefined : 'row'} className={`sticky top-0 z-10 grid shrink-0 items-center rounded border border-app-border bg-app-bg ${layout.grid}`}>
        {header('status', tr('board.table.col.status'), false)}
        {header('title', tr('board.table.col.title'), false)}
        {showProject && header('project', tr('board.table.col.project'), true)}
        {header('owner', tr('board.table.col.owner'), true)}
        {header('priority', tr('board.table.col.priority'), true)}
        {header('updated', tr('board.table.col.updated'), false)}
        <div role={grouped ? undefined : 'columnheader'} className={`h-7 min-w-0 ${layout.extra}`} aria-label={grouped ? undefined : tr('board.table.col.links')} />
      </div>
      {grouped ? (
        <GroupedBoard
          groups={groups} levels={levels} columns={columns} showColumnCounts={false} wide={false}
          collapsed={collapsed} onToggle={onToggle} nameById={nameById} pathById={pathById} labelOf={labelOf}
          draftAbove={draftAbove} renderLeaf={renderLeaf}
        />
      ) : <>
        {draftAbove && <div className="shrink-0"><DraftCard draft={draftAbove} /></div>}
        {rows(sortedAll)}
      </>}
      {tasks.length === 0 && !draftAbove && (
        <div data-testid="board-table-empty" className="px-2 py-6 text-center text-compact text-app-text-secondary">{tr('board.table.empty')}</div>
      )}
    </div>
  );
}
