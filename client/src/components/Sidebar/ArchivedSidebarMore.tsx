import { ROW_H, ROW_INSET, ROW_PX } from '@/lib/selectionStyles';

/**
 * The row under a sidebar group that draws more of its archived chats
 * (IDLE-03). A treeitem like every other row of the column, so the tree's
 * keys reach it, and a real button, so Enter and Space press it.
 */
export function ArchivedSidebarMore({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="treeitem"
      data-testid="sidebar-show-more-archived"
      className={`flex items-center ${ROW_PX} ${ROW_H} select-none text-mini text-app-text-muted hover:text-app-text-primary`}
      style={{ width: `calc(100% - ${ROW_INSET * 2}px)`, marginLeft: ROW_INSET }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
