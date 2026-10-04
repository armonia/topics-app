/**
 * Where a plain row of the changed-files strip opens: one the topic's
 * changeset does not hold. The rows of the changeset open in the strip's own
 * diff (`ChangedFilesStrip.test.tsx`, CHGSET-03); these keep the editor.
 *
 * @covers CHAT-CHANGES-01
 */
import { describe, test, expect } from 'bun:test';
import { changedFileOpen } from './changesStripOpen';
import type { TopicChanges } from '../../../shared/topic-changes';

const landed: TopicChanges = {
  files: [
    { path: 'src/a.ts', kind: 'created', turns: 1, lastAt: '', added: 2, removed: 0, inRange: true },
    { path: '/elsewhere/package.json', kind: 'modified', turns: 1, lastAt: '' },
  ],
  git: { root: '/repo', branch: 'main' },
  taskId: 'task-1',
  revs: { base: 'a'.repeat(40), head: 'b'.repeat(40) },
};

describe('changedFileOpen', () => {
  test('a row the range does not hold opens the editor diff, in the tree the route read', () => {
    expect(changedFileOpen(landed, '/elsewhere/package.json', '/project'))
      .toEqual({ kind: 'diff', filePath: '/elsewhere/package.json', projectPath: '/repo' });
  });

  test('outside a repository the row opens the file, and with no folder at all nothing', () => {
    const plain: TopicChanges = { files: [{ path: '/tmp/x.md', kind: 'created', turns: 1, lastAt: '' }], git: null, revs: null };
    expect(changedFileOpen(plain, '/tmp/x.md', '/project')).toEqual({ kind: 'file', path: '/tmp/x.md' });
    expect(changedFileOpen(plain, '/tmp/x.md', '')).toBeNull();
  });
});
