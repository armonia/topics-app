/**
 * Which side of a changed file exists at which revision, and where a picture
 * inside a rendered `.md` is read from. Both can be wrong without anything
 * looking broken: the Before of a renamed picture read at the new path is a
 * 404 drawn as "preview unavailable", and a README image read from disk shows
 * the main checkout's copy under a delivery that changed it.
 *
 * @covers DIFFPV-02, DIFFPV-03
 */
import { describe, expect, test } from 'bun:test';
import { previewSides, renderedSide, resolveMarkdownImagePath } from './diffPreview';
import { diffBlobUrl, diffBlobPath } from '../../lib/board';

const revs = { base: 'a'.repeat(40), head: 'b'.repeat(40) };
const live = { base: 'a'.repeat(40), head: null };

describe('previewSides', () => {
  test('a modified picture has both sides, at base and head', () => {
    expect(previewSides({ path: 'assets/logo.png', status: 'modified' }, revs)).toEqual({
      before: { path: 'assets/logo.png', rev: revs.base },
      after: { path: 'assets/logo.png', rev: revs.head },
    });
  });

  test('added has only the After, deleted only the Before, and a live After is the working tree', () => {
    expect(previewSides({ path: 'n.png', status: 'added' }, live)).toEqual({ before: null, after: { path: 'n.png', rev: 'worktree' } });
    expect(previewSides({ path: 'n.png', status: 'untracked' }, live).before).toBeNull();
    expect(previewSides({ path: 'd.png', status: 'deleted' }, revs)).toEqual({ before: { path: 'd.png', rev: revs.base }, after: null });
  });

  test('a renamed picture reads its Before at the old path', () => {
    const sides = previewSides({ path: 'docs/b.png', status: 'renamed', origPath: 'docs/a.png' }, revs);
    expect(sides.before).toEqual({ path: 'docs/a.png', rev: revs.base });
    expect(sides.after).toEqual({ path: 'docs/b.png', rev: revs.head });
  });

  test('the rendered side is the After, or the Before of a deleted file', () => {
    expect(renderedSide({ path: 'README.md', status: 'modified' }, live)).toEqual({ path: 'README.md', rev: 'worktree' });
    expect(renderedSide({ path: 'README.md', status: 'deleted' }, revs)).toEqual({ path: 'README.md', rev: revs.base });
  });
});

describe('resolveMarkdownImagePath', () => {
  test('a relative src is resolved from the folder of the .md', () => {
    expect(resolveMarkdownImagePath('README.md', 'docs/shot.png')).toBe('docs/shot.png');
    expect(resolveMarkdownImagePath('docs/guide.md', './img/a.png')).toBe('docs/img/a.png');
    expect(resolveMarkdownImagePath('docs/guide.md', '../assets/x.svg')).toBe('assets/x.svg');
    expect(resolveMarkdownImagePath('docs/guide.md', 'img/my%20shot.png?raw=1#top')).toBe('docs/img/my shot.png');
  });

  test('a leading slash is the repository root', () => {
    expect(resolveMarkdownImagePath('docs/guide.md', '/assets/x.png')).toBe('assets/x.png');
  });

  test('a path leaving the repository root, a URL, or a non-picture stays alternative text', () => {
    expect(resolveMarkdownImagePath('docs/guide.md', '../../x.png')).toBeNull();
    expect(resolveMarkdownImagePath('README.md', '../x.png')).toBeNull();
    expect(resolveMarkdownImagePath('README.md', '//cdn.example.com/x.png')).toBeNull();
    expect(resolveMarkdownImagePath('README.md', 'file:///etc/x.png')).toBeNull();
    expect(resolveMarkdownImagePath('README.md', 'docs/notes.txt')).toBeNull();
    expect(resolveMarkdownImagePath('README.md', '%E0%A4%A.png')).toBeNull();
  });
});

describe('the byte route of each panel source', () => {
  test('a card, an attempt and a publish each read from their own route', () => {
    const card = diffBlobPath({ kind: 'task', projectId: 'p', taskId: 't' }, 'assets/logo.png', revs.base);
    expect(card).toBe(`/api/boards/p/tasks/t/diff?file=assets%2Flogo.png&blob=${revs.base}`);
    expect(diffBlobPath({ kind: 'task', projectId: 'p', taskId: 't', attemptId: 'a1' }, 'x.png', 'worktree'))
      .toBe('/api/boards/p/tasks/t/diff?file=x.png&blob=worktree&attempt=a1');
    expect(diffBlobPath({ kind: 'publish', projectId: 'p' }, 'x.png', revs.head)).toBe(`/api/boards/p/publish-diff?file=x.png&blob=${revs.head}`);
    // Off the desktop shell the base is '' and the two forms coincide.
    expect(diffBlobUrl({ kind: 'publish', projectId: 'p' }, 'x.png', revs.head)).toBe(`/api/boards/p/publish-diff?file=x.png&blob=${revs.head}`);
  });
});
