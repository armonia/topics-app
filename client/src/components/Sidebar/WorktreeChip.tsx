import { GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/hooks/useT';
import { ON_FILL_TEXT_SOFT } from '@/lib/selectionStyles';
import type { WorktreeLabel } from '@/lib/sidebarWorktrees';

/**
 * The worktree a topic row works in, as a compact chip beside the name.
 *
 * An ATTRIBUTE of the row, like the cloud glyph of an OpenClaw session: it
 * says what the row is, not what it needs, so it sits outside the quiet rail
 * (`ROW_TRAIL`) where the signals live, and it takes no colour of its own.
 * On an attention fill it inherits the on-fill treatment like every other
 * glyph of the row — never a fixed colour over a fill.
 *
 * The name can be empty while the worktree list has not answered yet: the
 * chip still shows (the binding is the topic's own fact) with the generic
 * word, and takes the name the moment the list arrives.
 */
export function WorktreeChip({ worktree, onFill }: { worktree: WorktreeLabel; onFill: boolean }) {
  const tr = useT();
  const name = worktree.name || tr('sidebar.worktree');
  return (
    <span
      data-worktree-chip={worktree.id}
      className={cn(
        'flex-shrink-0 flex items-center gap-1 max-w-[96px] h-[18px] px-1.5 rounded-md',
        'text-[11px] leading-none',
        onFill ? cn(ON_FILL_TEXT_SOFT, 'bg-white/15') : 'text-app-text-secondary bg-app-hover',
      )}
      title={worktree.branchName ? `${name} · ${worktree.branchName}` : name}
      aria-label={tr('sidebar.inWorktree', { nome: name })}
    >
      <GitBranch size={11} aria-hidden="true" className="flex-shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}
