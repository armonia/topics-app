import { describe, expect, test } from 'bun:test';
import { projectNameIndexIds, resolveProjectRefs } from './boardProjectsStore';

/**
 * On the cross-project board's table view, a merged (`accorpa`) parent with
 * no task of its own in the current filter showed its raw board id instead
 * of its name («sito-armonia-hbjjm2 · Nuvola», not «Sito Armonia · Nuvola»):
 * the name map was built only from the VISIBLE tasks' project ids, and the
 * parent never appeared there.
 *
 * @covers 9e98df9f
 */
describe('projectNameIndexIds', () => {
  test('adds the index\'s ids to the visible tasks\' ids, so a parent with no task of its own still resolves', () => {
    const index = [
      { projectId: 'parent-1', name: 'Sito Armonia', path: '/sito-armonia' },
      { projectId: 'child-1', name: 'Nuvola', path: '/nuvola' },
    ];
    const ids = projectNameIndexIds(['child-1'], index);
    expect(ids).toContain('parent-1');
    expect(ids).toContain('child-1');
    const refs = resolveProjectRefs(ids, index);
    expect(refs.find((r) => r.projectId === 'parent-1')?.name).toBe('Sito Armonia');
  });

  test('a task\'s project not in the index stays, so it is still filterable by its own id', () => {
    const ids = projectNameIndexIds(['unregistered-id'], null);
    expect(ids).toEqual(['unregistered-id']);
  });

  test('no duplicate ids when a task\'s project is also in the index', () => {
    const index = [{ projectId: 'p1', name: 'P1', path: '/p1' }];
    expect(projectNameIndexIds(['p1'], index)).toEqual(['p1']);
  });
});
