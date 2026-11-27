import { describe, test, expect } from 'bun:test';
import { projectNamesForBoard } from './boardProjectsStore';

/**
 * A merged parent with no card of its own must head its group with a name, never a raw id.
 *
 * @covers KANBAN-02
 */
describe('group header names of a merged board', () => {
  test('a parent with only the merged child cards still gets its project name', () => {
    const index = [
      { projectId: 'site-7m106a', name: 'Site', path: '/p/site' },
      { projectId: 'child-abc123', name: 'Child', path: '/p/child' },
    ];
    const names = projectNamesForBoard(['child-abc123'], ['site-7m106a'], index);
    expect(names.get('site-7m106a')).toBe('Site');
    expect(names.get('child-abc123')).toBe('Child');
  });
});
