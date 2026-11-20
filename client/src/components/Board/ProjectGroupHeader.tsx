/**
 * The head of a project group, the SAME in the Kanban lanes and in the Plan
 * tiles: the project's icon and name, the fold chevron, and whatever counts the
 * view has to say on the right. Two views of one board read one header.
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Inbox, SquareKanban } from 'lucide-react';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { useT } from '../../hooks/useT';
import { STATUS_LABEL } from '../../lib/board';
import type { WorkflowColumn } from '../../../../shared/workflow';
import { StatusIcon } from './atoms';
import type { BoardLane } from './boardLanes';

/** A board with no folder (a virtual board, or cards with no project) gets a neutral glyph, so headers stay aligned. */
export function ProjectGlyph({ projectId, path }: { projectId: string; path?: string | null }) {
  const Glyph = projectId === '_none' ? Inbox : SquareKanban;
  const glyph = <Glyph className="h-4 w-4 shrink-0 text-app-text-muted" aria-hidden />;
  // A folder with no icon file gets the same glyph as no folder: the Kanban
  // knows the folder and the Plan may not, and one project must read alike.
  return path ? <ProjectFavicon path={path} size={16} className="shrink-0" fallback={glyph} /> : glyph;
}

interface Props {
  projectId: string;
  name: string;
  path?: string | null;
  collapsed: boolean;
  onToggle: () => void;
  /** The view's own facts about the group (counts per column, open work, signals). */
  children?: ReactNode;
  testId?: string;
  /** Replaces the project glyph when the group is not a project (`null` = no icon). */
  icon?: ReactNode;
}

export function ProjectGroupHeader({ projectId, name, path, collapsed, onToggle, children, testId, icon }: Props) {
  const tr = useT();
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <header className="flex min-w-0 items-center gap-2" data-testid={testId}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={tr(collapsed ? 'board.group.expand' : 'board.group.collapse', { name })}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-app-hover"
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-app-text-muted" aria-hidden />
        {icon === undefined ? <ProjectGlyph projectId={projectId} path={path} /> : icon}
        <h3 className="min-w-0 truncate text-compact font-semibold text-app-text-heading">{name}</h3>
      </button>
      {children}
    </header>
  );
}

/**
 * A lane's cards per column, as the columns name them: the icon of the column
 * and its number, the empty ones skipped (a row of zeros says nothing). The
 * whole is in the title, for whoever wants the full sentence.
 */
export function LaneCounts({ lane, columns }: { lane: Pick<BoardLane, 'counts' | 'total'>; columns: readonly WorkflowColumn[] }) {
  const tr = useT();
  const shown = columns.filter((c) => (lane.counts[c.id] ?? 0) > 0);
  return (
    <span className="flex shrink-0 items-center gap-2" data-testid="board-lane-counts" title={tr('board.group.total', { n: lane.total })}>
      {shown.map((c) => (
        <span key={c.id} data-testid={`board-lane-count-${c.id}`} title={c.id === c.base ? STATUS_LABEL[c.base] : c.label}
          className="flex items-center gap-1 text-mini tabular-nums text-app-text-muted">
          <StatusIcon status={c.base} className="h-3 w-3" />{lane.counts[c.id]}
        </span>
      ))}
    </span>
  );
}
