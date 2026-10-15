import { useState, type ReactNode } from 'react';
import { useT } from '@/hooks/useT';
import type { SidebarItem } from '@/lib/buildSidebarItems';
import { ARCHIVED_SIDEBAR_PAGE_SIZE, pageArchivedSidebarItems } from '@/lib/sidebarArchivePaging';
import { ArchivedSidebarMore } from './ArchivedSidebarMore';

/**
 * Pages of archived chats, one per sidebar group (IDLE-03). With the
 * show-archived switch on, a group draws its 25 most recent archived chats and
 * a row that adds 25 more; a search shows every match, unpaged.
 */
export function useArchivedSidebarPages(showArchived: boolean, searching: boolean, alwaysVisibleIds: ReadonlySet<string>) {
  const tr = useT();
  // Turning the show-archived switch off or on starts every group over at 25. The
  // reset happens here, during render, the way React documents reacting to a
  // prop change: an effect would paint one frame with the old pages first.
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [sizesShowArchived, setSizesShowArchived] = useState(showArchived);
  if (sizesShowArchived !== showArchived) {
    setSizesShowArchived(showArchived);
    setSizes({});
  }

  const page = (groupId: string, items: SidebarItem[]) =>
    showArchived && !searching
      ? pageArchivedSidebarItems(items, sizes[groupId] ?? ARCHIVED_SIDEBAR_PAGE_SIZE, alwaysVisibleIds)
      : { items, remaining: 0 };

  const showMore = (groupId: string, remaining: number) => remaining > 0 ? (
    <ArchivedSidebarMore
      key={`show-more-archived:${groupId}`}
      label={remaining === 1
        ? tr('sidebar.archivedMore.one')
        : tr('sidebar.archivedMore.many', { count: Math.min(remaining, ARCHIVED_SIDEBAR_PAGE_SIZE), remaining })}
      onClick={() => setSizes(current => ({
        ...current,
        [groupId]: (current[groupId] ?? ARCHIVED_SIDEBAR_PAGE_SIZE) + ARCHIVED_SIDEBAR_PAGE_SIZE,
      }))}
    />
  ) : null;

  const pagedRows = (groupId: string, items: SidebarItem[], render: (items: SidebarItem[]) => ReactNode) => {
    const { items: shown, remaining } = page(groupId, items);
    return <>{render(shown)}{showMore(groupId, remaining)}</>;
  };

  return { page, showMore, pagedRows };
}
