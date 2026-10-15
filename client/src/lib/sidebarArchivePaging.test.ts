/** @covers IDLE-03 */
import { describe, expect, test } from 'bun:test';
import { pageArchivedSidebarItems } from './sidebarArchivePaging';
import type { SidebarItem } from './buildSidebarItems';

function chat(id: string, lastActivity: number, archived = true, extra: Partial<SidebarItem> = {}): SidebarItem {
  return {
    id,
    type: 'chat',
    name: id,
    icon: '',
    lastActivity,
    notificationCount: 0,
    archived,
    ...extra,
  };
}

const ids = (items: SidebarItem[]) => items.map(item => item.id);

describe('pageArchivedSidebarItems', () => {
  test('keeps the 25 most recent archived chats and reports the rest', () => {
    const rows = Array.from({ length: 60 }, (_, index) => chat(`chat-${index}`, index));
    const page = pageArchivedSidebarItems(rows, 25);

    expect(ids(page.items)).toEqual(Array.from({ length: 25 }, (_, index) => `chat-${35 + index}`));
    expect(page.remaining).toBe(35);
  });

  test('drops rows without reordering the ones it keeps', () => {
    const rows = [chat('a', 5), chat('regular-1', 2, false), chat('b', 9), chat('regular-2', 0, false), chat('c', 1)];

    expect(ids(pageArchivedSidebarItems(rows, 2).items)).toEqual(['a', 'regular-1', 'b', 'regular-2']);
  });

  test('keeps every regular row and pinned or active archives outside the page size', () => {
    const rows = [
      chat('regular', 1, false),
      ...Array.from({ length: 30 }, (_, index) => chat(`chat-${index}`, index)),
      chat('pinned', 40, true, { pinned: true }),
      chat('active', 41),
    ];
    const page = pageArchivedSidebarItems(rows, 25, new Set(['active']));

    expect(ids(page.items)).toContain('regular');
    expect(ids(page.items)).toContain('pinned');
    expect(ids(page.items)).toContain('active');
    expect(page.items.filter(item => item.type === 'chat' && item.archived)).toHaveLength(27);
    expect(page.remaining).toBe(5);
  });

  test('does not page non-chat rows', () => {
    const terminal: SidebarItem = {
      id: 'terminal:1', type: 'terminal', name: 'Terminal', icon: '', lastActivity: 0,
      notificationCount: 0, archived: false,
    };
    const page = pageArchivedSidebarItems([terminal], 25);
    expect(page.items).toEqual([terminal]);
    expect(page.remaining).toBe(0);
  });
});
