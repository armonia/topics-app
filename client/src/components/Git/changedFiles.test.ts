/**
 * THREE WIRE SHAPES, ONE ROW.
 *
 * The list of files git touched reaches the screen from three different routes,
 * and each speaks its own dialect: a semantic kind for the chat strip, a
 * name-status letter for a delivery, the porcelain XY pair for the project
 * panel. The renderer used to learn all three, once per surface, which is how
 * the same delivery could show `+/-` without ever saying a file had been
 * deleted.
 *
 * What is asserted here is the CONVERSION, and in particular the two places it
 * can lie:
 *  · a binary file, which git reports as `-1` and not as zero;
 *  · an absent count, which is NOT a count of zero.
 *
 * @covers GIT-FILELIST-01
 */
import { describe, expect, test } from 'bun:test';
import {
  rowFromDiffStat,
  rowFromGitFile,
  rowFromTopicChange,
  splitPath,
  statusFromPorcelain,
} from './changedFiles';

describe('the topic strip shape', () => {
  test('the three kinds become the three statuses, counts included', () => {
    const row = rowFromTopicChange({ path: 'a/b.ts', kind: 'created', turns: 1, lastAt: '', added: 3, removed: 1 });
    expect(row).toMatchObject({ path: 'a/b.ts', status: 'added', added: 3, removed: 1 });
    expect(rowFromTopicChange({ path: 'x', kind: 'deleted', turns: 1, lastAt: '' }).status).toBe('deleted');
    expect(rowFromTopicChange({ path: 'x', kind: 'modified', turns: 1, lastAt: '' }).status).toBe('modified');
  });

  test('a file outside a repo carries NO counts, and that is not a zero', () => {
    const row = rowFromTopicChange({ path: 'x', kind: 'modified', turns: 1, lastAt: '' });
    expect(row.added).toBeUndefined();
    expect(row.removed).toBeUndefined();
  });
});

describe('the diff stat shape (delivery, publish range)', () => {
  test('the name-status letter becomes the status, similarity score included', () => {
    expect(rowFromDiffStat({ path: 'a', additions: 1, deletions: 0, status: 'A' }).status).toBe('added');
    expect(rowFromDiffStat({ path: 'a', additions: 0, deletions: 9, status: 'D' }).status).toBe('deleted');
    expect(rowFromDiffStat({ path: 'a', additions: 0, deletions: 0, status: 'R100' }).status).toBe('renamed');
    expect(rowFromDiffStat({ path: 'a', additions: 2, deletions: 2, status: 'M' }).status).toBe('modified');
  });

  test('a binary file is FLAGGED and carries no numbers: -1 lines were never removed', () => {
    const row = rowFromDiffStat({ path: 'img.png', additions: -1, deletions: -1, status: 'A' });
    expect(row.binary).toBe(true);
    expect(row.added).toBeUndefined();
    expect(row.removed).toBeUndefined();
  });
});

describe('the porcelain shape (project panel)', () => {
  test('the two sides are read SEPARATELY: a half-staged file has two truths', () => {
    const file = {
      path: 'src/x.ts',
      status: 'MM',
      staged: { added: 10, removed: 0 },
      unstaged: { added: 1, removed: 4 },
    };
    expect(rowFromGitFile(file, 'staged')).toMatchObject({ added: 10, removed: 0 });
    expect(rowFromGitFile(file, 'unstaged')).toMatchObject({ added: 1, removed: 4 });
  });

  test('a code whose two letters say two things survives as itself', () => {
    expect(rowFromGitFile({ path: 'x', status: 'MM' }, 'staged').code).toBe('MM');
    // ` M` says "modified" once: a badge repeating it would be a second letter
    // that means nothing.
    expect(rowFromGitFile({ path: 'x', status: ' M' }, 'unstaged').code).toBeUndefined();
    // Untracked has its own letter (U); two question marks name nothing.
    expect(rowFromGitFile({ path: 'x', status: '??' }, 'unstaged').code).toBeUndefined();
  });

  test('a conflict is its own state, not a modification', () => {
    for (const code of ['UU', 'AA', 'DD', 'AU', 'UD']) {
      expect(statusFromPorcelain(code)).toBe('conflicted');
    }
    expect(statusFromPorcelain('??')).toBe('untracked');
    expect(statusFromPorcelain('R ')).toBe('renamed');
  });

  test('a rename keeps the name it came from, and its binary side stays uncounted', () => {
    const row = rowFromGitFile(
      { path: 'new.ts', status: 'R ', origPath: 'old.ts', staged: { added: 0, removed: 0, binary: true } },
      'staged',
    );
    expect(row.origPath).toBe('old.ts');
    expect(row.binary).toBe(true);
    expect(row.added).toBeUndefined();
  });
});

describe('splitting a path', () => {
  test('the folder keeps its slash and the name is whole', () => {
    expect(splitPath('client/src/lib/thing.ts')).toEqual({ dir: 'client/src/lib/', name: 'thing.ts' });
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });
});
