/**
 * The board cut into groups, up to two levels deep: a section per group with
 * its header (fold, name, count) and, inside a first-level group, a sub-section
 * per second-level group. What a LEAF holds is the view's business
 * (`renderLeaf`): a row of status columns, a list, or a grid of cards.
 * The tree itself comes from `boardGrouping.ts`.
 */
import type { ReactNode } from 'react';
import type { WorkflowColumn } from '../../../../shared/workflow';
import { useT } from '../../hooks/useT';
import type { BoardTask } from '../../lib/board';
import { columnOfTask } from '../../../../shared/workflow';
import type { GroupKey, GroupNode } from './boardGrouping';
import { NO_VALUE } from './boardGrouping';
import { LaneCounts, ProjectGroupHeader } from './ProjectGroupHeader';
import { DraftCard } from './DraftCard';
import type { DraftPreview } from './draftPreview';

/** A group's cards per column, for the header counts. */
function countsOf(node: GroupNode, columns: readonly WorkflowColumn[]): { counts: Record<string, number>; total: number } {
  const counts: Record<string, number> = Object.fromEntries(columns.map((c) => [c.id, 0]));
  for (const t of node.tasks) {
    const col = columnOfTask(columns, t as BoardTask);
    if (col) counts[col.id] += 1;
  }
  return { counts, total: node.count };
}

export function GroupedBoard({ groups, levels, columns, showColumnCounts, wide, collapsed, onToggle, forceOpenPath, labelOf, nameById, pathById, draftAbove, renderLeaf }: {
  groups: readonly GroupNode[];
  levels: readonly GroupKey[];
  columns: readonly WorkflowColumn[];
  /** Per-status counts in the header: the views that have status columns. */
  showColumnCounts: boolean;
  /** The list view caps the reading width. */
  wide: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  /** The group holding the composer's ghost stays open even if folded, or the ghost would vanish. */
  forceOpenPath?: (node: GroupNode) => boolean;
  labelOf: (level: GroupKey, key: string) => string;
  nameById: ReadonlyMap<string, string>;
  pathById: ReadonlyMap<string, string>;
  draftAbove?: DraftPreview;
  renderLeaf: (node: GroupNode) => ReactNode;
}) {
  const tr = useT();
  const frame = wide ? 'mx-auto w-full max-w-3xl' : '';

  const section = (node: GroupNode, depth: number): ReactNode => {
    const level = levels[depth];
    const isProject = level === 'project' && node.key !== NO_VALUE;
    const folded = collapsed.has(node.path) && !forceOpenPath?.(node);
    const name = isProject ? nameById.get(node.key) ?? node.key : labelOf(level, node.key);
    const top = depth === 0;
    return (
      <section
        key={node.path}
        data-testid={top && level === 'project' ? 'board-lane' : 'board-group'}
        data-project-id={top && level === 'project' ? node.key : undefined}
        data-group-path={node.path} data-group-level={level} data-collapsed={folded || undefined}
        className={`flex shrink-0 flex-col gap-2 ${frame} ${top ? '' : 'pl-3'}`}
      >
        <ProjectGroupHeader
          projectId={isProject ? node.key : NO_VALUE}
          name={name}
          path={isProject ? pathById.get(node.key) : undefined}
          icon={isProject ? undefined : null}
          collapsed={folded}
          onToggle={() => onToggle(node.path)}
          testId={top && level === 'project' ? 'board-lane-header' : 'board-group-header'}
        >
          <span data-testid="board-group-count" title={tr('board.group.total', { n: node.count })}
            className="shrink-0 rounded-full bg-white/10 px-1.5 text-mini tabular-nums text-app-text-secondary">{node.count}</span>
          {showColumnCounts && top && <LaneCounts lane={countsOf(node, columns)} columns={columns} />}
        </ProjectGroupHeader>
        {!folded && (node.children.length ? node.children.map((c) => section(c, depth + 1)) : renderLeaf(node))}
      </section>
    );
  };

  return <>
    {draftAbove && (
      <div data-testid="board-draft-above" className={`shrink-0 ${wide ? 'mx-auto w-full max-w-3xl' : 'w-full max-w-sm'}`}>
        <DraftCard draft={draftAbove} />
      </div>
    )}
    {groups.map((g) => section(g, 0))}
  </>;
}
