import type { ReactNode } from 'react';
import { GitBranch, Plus } from 'lucide-react';
import { useT } from '@/hooks/useT';
import {
  sidebarRowCard, ROW_CARD, ROW_PX, ROW_GAP, ROW_INSET, ROW_GLYPH, ROW_GLYPH_SLOT,
  ROW_ACTIONS, ROW_ACTION_BOX, ROW_ACTION_GLYPH, SECTION_H, SIDEBAR_INDENT_STEP, TAB_LABEL,
} from '@/lib/selectionStyles';

interface WorktreeSectionProps {
  worktreeId: string;
  /** Empty while the worktree list has not answered: the header then says
   *  the generic word, and takes the name when the list arrives. */
  name: string;
  branchName: string | null;
  /** Nesting level of the HEADER; the rows inside sit one step deeper. */
  depth: number;
  /** "New topic in this worktree" — opens the creation dialog with this
   *  worktree preselected. Hidden when the host has no dialog to open. */
  onNewTopic?: () => void;
  children: ReactNode;
}

/**
 * One worktree's slice of a project, inside the project's accordion.
 *
 * It exists only when a project has live topics on MORE THAN ONE worktree
 * (see `groupProjectChildrenByWorktree`): a header with the worktree's name
 * and branch, and the topic rows beneath it, one step deeper. Topics that
 * work in the project's own checkout stay in the base list above, exactly
 * where they were before worktrees had a row of their own.
 *
 * A `role="group"` inside the tree, named after the worktree: that is the
 * ARIA shape for "these treeitems belong together", and it is what lets the
 * header carry a label without pretending to be a row.
 *
 * The header is a SECTION row (`SECTION_H`, not `ROW_H`): the same height and
 * the same card as the section headers of the state view, so the sidebar has
 * one way of saying "what follows is grouped". Its only command — the "+" —
 * lives in the shared action rail (`ROW_ACTIONS`): revealed on hover, always
 * present under a finger, and it opens the SAME creation dialog the project
 * "+" opens, with the worktree already chosen. Not a second worktree picker.
 */
export function WorktreeSection({ worktreeId, name, branchName, depth, onNewTopic, children }: WorktreeSectionProps) {
  const tr = useT();
  const label = name || tr('sidebar.worktree');
  return (
    <div
      role="group"
      aria-label={tr('sidebar.worktreeSection', { nome: label })}
      data-testid={`worktree-section-${worktreeId}`}
      className="flex flex-col"
    >
      <div
        className={`group ${ROW_CARD} flex items-center ${ROW_GAP} ${SECTION_H} ${ROW_PX} select-none ${sidebarRowCard({ nested: true })}`}
        style={{ marginLeft: ROW_INSET + depth * SIDEBAR_INDENT_STEP }}
        data-worktree-header={worktreeId}
      >
        <span className={ROW_GLYPH_SLOT} data-row-glyph-slot="glyph">
          <GitBranch size={ROW_GLYPH} aria-hidden="true" className="text-app-text-secondary" />
        </span>
        <span className={`${TAB_LABEL} truncate min-w-0`} data-row-name="worktree">{label}</span>
        {branchName && (
          <span className="font-mono text-[11px] text-app-text-tertiary truncate min-w-0 flex-1" title={branchName}>
            {branchName}
          </span>
        )}
        {onNewTopic && (
          <span className={ROW_ACTIONS}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onNewTopic(); }}
              className={`${ROW_ACTION_BOX} flex items-center justify-center rounded-md text-app-text-tertiary hover:text-app-text hover:bg-app-hover transition-colors`}
              title={tr('sidebar.newTopicInWorktree')}
              aria-label={tr('sidebar.newTopicInWorktree')}
              data-testid={`worktree-new-topic-${worktreeId}`}
            >
              <Plus size={ROW_ACTION_GLYPH} />
            </button>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
