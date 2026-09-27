/**
 * Where a row of the changed-files strip opens.
 *
 * On a task topic the strip lists the task's own diff range, and after the
 * land that range lives in the project's checkout. The editor's diff there
 * compares HEAD with the disk: the row said `+2` and the diff that opened was
 * empty, or somebody else's work in progress. A row counted on the range opens
 * the task's drawer on that file instead; every other row keeps the editor.
 *
 * @covers CHAT-CHANGES-01
 */
import { describe, test, expect } from 'bun:test';
import { changedFileOpen } from './changesStripOpen';
import { diffFocusPath } from '../components/Board/constants';
import type { TopicChanges } from '../../../shared/topic-changes';

const landed: TopicChanges = {
  files: [
    { path: 'src/a.ts', kind: 'created', turns: 1, lastAt: '', added: 2, removed: 0, inRange: true },
    { path: '/elsewhere/package.json', kind: 'modified', turns: 1, lastAt: '' },
  ],
  git: { root: '/repo', branch: 'main' },
  taskId: 'task-1',
};

describe('changedFileOpen', () => {
  test('a row counted on the task range opens the task drawer, focused on that file', () => {
    const target = changedFileOpen(landed, 'src/a.ts', '/repo');
    expect(target).toMatchObject({ kind: 'task', taskId: 'task-1' });
    expect(target?.kind === 'task' ? diffFocusPath(target.focusPaneId) : null).toBe('src/a.ts');
  });

  test('a row the range does not hold opens the editor diff, in the tree the route read', () => {
    expect(changedFileOpen(landed, '/elsewhere/package.json', '/project'))
      .toEqual({ kind: 'diff', filePath: '/elsewhere/package.json', projectPath: '/repo' });
  });

  test('without a task, an inRange row still opens the editor: there is no drawer to open', () => {
    expect(changedFileOpen({ ...landed, taskId: undefined }, 'src/a.ts', '/project'))
      .toEqual({ kind: 'diff', filePath: 'src/a.ts', projectPath: '/repo' });
  });

  test('outside a repository the row opens the file, and with no folder at all nothing', () => {
    const plain: TopicChanges = { files: [{ path: '/tmp/x.md', kind: 'created', turns: 1, lastAt: '' }], git: null };
    expect(changedFileOpen(plain, '/tmp/x.md', '/project')).toEqual({ kind: 'file', path: '/tmp/x.md' });
    expect(changedFileOpen(plain, '/tmp/x.md', '')).toBeNull();
  });
});
