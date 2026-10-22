import type { SidebarItem } from './buildSidebarItems';

export const ARCHIVED_SIDEBAR_PAGE_SIZE = 25;

export interface ArchivedSidebarPage {
  items: SidebarItem[];
  remaining: number;
}

/**
 * Which archived chats one sidebar group draws (IDLE-03): the
 * `visibleArchivedCount` most recent, plus the pinned and active ones whatever
 * their age. Every other row stays, and so does the order of the list: the
 * page only drops rows, so turning the show-archived switch on never
 * reshuffles what was already there.
 */
export function pageArchivedSidebarItems(
  items: SidebarItem[],
  visibleArchivedCount: number,
  alwaysVisibleIds: ReadonlySet<string> = new Set(),
): ArchivedSidebarPage {
  const isPaged = (item: SidebarItem) =>
    item.type === 'chat' && item.archived && !item.pinned && !alwaysVisibleIds.has(item.id);
  const paged = items.filter(isPaged);
  if (paged.length <= visibleArchivedCount) return { items, remaining: 0 };
  const kept = new Set(
    paged
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, visibleArchivedCount)
      .map(item => item.id),
  );
  return {
    items: items.filter(item => !isPaged(item) || kept.has(item.id)),
    remaining: paged.length - kept.size,
  };
}
