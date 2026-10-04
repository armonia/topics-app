/**
 * The sub-agents accordion starts closed, counts every descendant, says when
 * one is working, and opens by itself only while a child is the focused row.
 * @covers SUBAGENT-21
 */
import { describe, expect, test } from 'bun:test';
import type { SidebarItem } from './buildSidebarItems';
import { isAccordionOpen, summarizeSubagents, toggledAccordions } from './subagentAccordion';

const item = (id: string, subAgents?: SidebarItem[]): SidebarItem =>
  ({ id, type: 'chat', name: id, icon: '', lastActivity: 0, notificationCount: 0, archived: false, ...(subAgents ? { subAgents } : {}) }) as SidebarItem;

describe('sub-agents accordion', () => {
  const tree = [item('a', [item('a1')]), item('b')];

  test('closed by default: nothing opened, nothing focused', () => {
    const s = summarizeSubagents(tree, () => false, () => false);
    expect(s).toEqual({ count: 3, working: false, holdsFocus: false });
    expect(isAccordionOpen('parent', new Set(), s)).toBe(false);
  });

  test('a working grandchild lights the header dot, without opening it', () => {
    const s = summarizeSubagents(tree, (i) => i.id === 'a1', () => false);
    expect(s.working).toBe(true);
    expect(isAccordionOpen('parent', new Set(), s)).toBe(false);
  });

  test('opens on a click, and while a child is the row in front', () => {
    expect(isAccordionOpen('parent', toggledAccordions(new Set(), 'parent'), { holdsFocus: false })).toBe(true);
    expect(toggledAccordions(new Set(['parent']), 'parent').has('parent')).toBe(false);
    const focused = summarizeSubagents(tree, () => false, (i) => i.id === 'b');
    expect(isAccordionOpen('parent', new Set(), focused)).toBe(true);
  });
});
