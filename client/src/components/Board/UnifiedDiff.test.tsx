/**
 * A FILE PAST THE PAYLOAD CAP CAN BE READ, A FOCUSED FILE IS OPEN, AND A FILE
 * IS SHOWN AS WHAT IT IS.
 *
 * The bundle stops at ~200 KB, and every file past it showed a "patch did
 * not arrive" notice with nothing to click (task 7657f201: 30 of 74). Now every
 * panel source (a card, an attempt, a publish) offers to fetch that one file
 * (`GET …?file=`, pinned in `server/routes/tasks.diff-panel.test.ts`).
 *
 * A changed picture used to be the words "binary file" and a `.md` only its
 * `+/-` lines. Now a picture is a Before/After pair read at the two revisions
 * the bundle names, a `.md`/`.svg` opens on the diff with a "Preview" switch,
 * and a text file can be read whole with its review notes still on their rows.
 *
 * (No DOM in this repo's unit runner, so the mount is `renderToStaticMarkup`:
 * each view is rendered as the state a click leads to. The clicks are E2E's.)
 *
 * @covers KANBAN-43, DIFFPV-02, DIFFPV-03, DIFFPV-04
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffLines, UnifiedDiff } from './UnifiedDiff';
import { chunkFromFilePatch } from './diffFileRows';
import MarkdownPreview from '../Editor/MarkdownPreview';
import type { DiffBundle, DiffFileStat, DiffPanelSource } from '../../lib/board';
import type { DiffNote } from './reviewNotes';

const TASK: DiffPanelSource = { kind: 'task', projectId: 'p', taskId: 't' };
const PUBLISH: DiffPanelSource = { kind: 'publish', projectId: 'p' };
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const patchFor = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const binaryPatchFor = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\nBinary files a/${path} and b/${path} differ\n`;

/** Two files in the stat, only the first in the (cut) patch. */
const cut: DiffBundle = {
  branch: 'topics/x',
  stat: [
    { path: 'a.ts', additions: 1, deletions: 1, status: 'M' },
    { path: 'z.ts', additions: 1, deletions: 1, status: 'M' },
  ],
  patch: patchFor('a.ts'),
  truncated: true,
};

/** One binary file, focused so its body is drawn. */
function binaryBundle(stat: DiffFileStat, revs: DiffBundle['revs'] = { base: BASE, head: HEAD }): DiffBundle {
  return { branch: 'topics/x', stat: [stat], patch: binaryPatchFor(stat.path), truncated: false, revs };
}

const srcOf = (html: string, testId: string) => new RegExp(`<img data-testid="${testId}" src="([^"]+)"`).exec(html)?.[1] ?? null;

describe('a file the bundle left out', () => {
  test('on a task diff, the missing file offers to load its own patch', () => {
    const html = renderToStaticMarkup(<UnifiedDiff bundle={cut} source={TASK} focusPath="z.ts" />);
    expect(html).toContain('data-testid="diff-load-file"');
  });

  test('a publish diff can load it too: the publish route now answers `?file=`', () => {
    const html = renderToStaticMarkup(<UnifiedDiff bundle={cut} source={PUBLISH} focusPath="z.ts" />);
    expect(html).toContain('data-testid="diff-load-file"');
  });

  test('the per-file answer is split to the chunk of THAT file', () => {
    expect(chunkFromFilePatch('z.ts', patchFor('z.ts'))?.body).toContain('+new');
    expect(chunkFromFilePatch('z.ts', '')).toBeNull();
  });
});

describe('the file the panel was opened on', () => {
  test('is marked and expanded, the others stay closed', () => {
    const html = renderToStaticMarkup(<UnifiedDiff bundle={{ ...cut, truncated: false, patch: patchFor('a.ts') + patchFor('z.ts') }} source={TASK} focusPath="z.ts" />);
    expect(html).toMatch(/data-path="z\.ts" data-focused="1"/);
    expect(html).not.toMatch(/data-path="a\.ts" data-focused/);
    // Expanded: its lines are in the document. `a.ts` is closed, so only one
    // `+new` is drawn.
    expect(html.match(/\+new/g)).toHaveLength(1);
  });
});

describe('a changed picture is a Before/After pair (DIFFPV-02)', () => {
  test('both sides read the byte route at the two revisions, and "binary" is gone', () => {
    const html = renderToStaticMarkup(
      <UnifiedDiff bundle={binaryBundle({ path: 'assets/logo.png', additions: -1, deletions: -1, status: 'M' })} source={TASK} focusPath="assets/logo.png" />,
    );
    expect(html).toContain('data-testid="diff-image-pair"');
    expect(srcOf(html, 'diff-image-before')).toBe(`/api/boards/p/tasks/t/diff?file=assets%2Flogo.png&amp;blob=${BASE}`);
    expect(srcOf(html, 'diff-image-after')).toBe(`/api/boards/p/tasks/t/diff?file=assets%2Flogo.png&amp;blob=${HEAD}`);
    expect(html).toContain('loading="lazy"');
    // The body notice (`diff.binary`); the row's `bin` chip and its title still say what git counted.
    expect(html).not.toContain('nessun diff testuale');
  });

  test('a picture new on the live worktree has only the After, read from the working tree', () => {
    const html = renderToStaticMarkup(
      <UnifiedDiff bundle={binaryBundle({ path: 'new.png', additions: -1, deletions: -1, status: 'A' }, { base: BASE, head: null })} source={TASK} focusPath="new.png" />,
    );
    expect(srcOf(html, 'diff-image-before')).toBeNull();
    expect(srcOf(html, 'diff-image-after')).toBe('/api/boards/p/tasks/t/diff?file=new.png&amp;blob=worktree');
  });

  test('a deleted picture has only the Before; a renamed one reads its Before at the old path', () => {
    const gone = renderToStaticMarkup(
      <UnifiedDiff bundle={binaryBundle({ path: 'old.png', additions: -1, deletions: -1, status: 'D' })} source={TASK} focusPath="old.png" />,
    );
    expect(srcOf(gone, 'diff-image-after')).toBeNull();
    expect(srcOf(gone, 'diff-image-before')).toContain(`blob=${BASE}`);

    const moved = renderToStaticMarkup(
      <UnifiedDiff bundle={binaryBundle({ path: 'docs/b.png', additions: -1, deletions: -1, status: 'R100', origPath: 'docs/a.png' })} source={TASK} focusPath="docs/b.png" />,
    );
    expect(srcOf(moved, 'diff-image-before')).toContain('file=docs%2Fa.png');
    expect(srcOf(moved, 'diff-image-after')).toContain('file=docs%2Fb.png');
  });

  test('another binary stays "binary", and no byte is asked for', () => {
    const html = renderToStaticMarkup(
      <UnifiedDiff bundle={binaryBundle({ path: 'doc.pdf', additions: -1, deletions: -1, status: 'A' })} source={TASK} focusPath="doc.pdf" />,
    );
    expect(html).toContain('nessun diff testuale');
    expect(html).not.toContain('<img');
  });

  test('nothing is downloaded while the file stays closed', () => {
    const bundle: DiffBundle = {
      branch: 'topics/x',
      stat: [
        { path: 'a.png', additions: -1, deletions: -1, status: 'M' },
        { path: 'b.png', additions: -1, deletions: -1, status: 'M' },
      ],
      patch: binaryPatchFor('a.png') + binaryPatchFor('b.png'),
      truncated: false,
      revs: { base: BASE, head: HEAD },
    };
    expect(renderToStaticMarkup(<UnifiedDiff bundle={bundle} source={TASK} />)).not.toContain('<img');
  });

  test('a publish reads the same pair from its own route', () => {
    const html = renderToStaticMarkup(
      <UnifiedDiff bundle={binaryBundle({ path: 'x.png', additions: -1, deletions: -1, status: 'M' })} source={PUBLISH} focusPath="x.png" />,
    );
    expect(srcOf(html, 'diff-image-after')).toBe(`/api/boards/p/publish-diff?file=x.png&amp;blob=${HEAD}`);
  });
});

describe('.md and .svg open on the diff, with a Preview switch (DIFFPV-03)', () => {
  test('a changed README shows its +/- lines and the switch set on "Diff"', () => {
    const bundle: DiffBundle = {
      branch: 'topics/x',
      stat: [{ path: 'README.md', additions: 1, deletions: 1, status: 'M' }],
      patch: patchFor('README.md'),
      truncated: false,
      revs: { base: BASE, head: null },
    };
    const html = renderToStaticMarkup(<UnifiedDiff bundle={bundle} source={TASK} focusPath="README.md" />);
    expect(html).toContain('+new');
    expect(html).toMatch(/data-testid="diff-view-diff" aria-pressed="true"/);
    expect(html).toMatch(/data-testid="diff-view-preview" aria-pressed="false"/);
    expect(html).toMatch(/data-testid="diff-view-full" aria-pressed="false"/);
  });

  test('without revisions to read at, there is no preview to offer', () => {
    const bundle: DiffBundle = {
      branch: 'topics/x',
      stat: [{ path: 'README.md', additions: 1, deletions: 1, status: 'M' }],
      patch: patchFor('README.md'),
      truncated: false,
    };
    const html = renderToStaticMarkup(<UnifiedDiff bundle={bundle} source={TASK} focusPath="README.md" />);
    expect(html).not.toContain('diff-view-preview');
  });

  test('the rendered .md reads its pictures through the resolver, and one it refuses stays alt text', () => {
    const resolve = (src: string) => (src === 'docs/shot.png' ? `/bytes?file=${src}&blob=worktree` : null);
    const html = renderToStaticMarkup(
      <MarkdownPreview content={'# Title\n\n![shot](docs/shot.png)\n\n![escape](../../x.png)\n'} baseDir="" resolveImage={resolve} />,
    );
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toContain('src="/bytes?file=docs/shot.png&amp;blob=worktree"');
    expect(html).not.toContain('../../x.png');
    expect(html).toContain('escape');
  });
});

describe('"Full file" keeps review notes on their rows (DIFFPV-04)', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
  const header = 'diff --git a/server/x.ts b/server/x.ts\n--- a/server/x.ts\n+++ b/server/x.ts\n';
  const hunk = `${header}@@ -38,5 +38,5 @@\n line 38\n line 39\n-line 40\n+line 40 changed\n line 41\n line 42\n`;
  const full = `${header}@@ -1,80 +1,80 @@\n${lines.map((l, i) => (i === 39 ? '-line 40\n+line 40 changed' : ` ${l}`)).join('\n')}\n`;
  const note: DiffNote = { id: 'n1', path: 'server/x.ts', line: 40, side: 'new', code: '+line 40 changed', body: 'NOTE-ON-40' };
  const review = { notes: [note], onAddNote: () => {}, onRemoveNote: () => {} };

  /** The note sits right under the row it is anchored to: after new:40, before new:41. */
  function noteUnderRow40(html: string) {
    const row = html.indexOf('data-anchor="new:40"');
    const at = html.indexOf('NOTE-ON-40');
    const next = html.indexOf('data-anchor="new:41"');
    expect(row).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(row);
    expect(next).toBeGreaterThan(at);
  }

  test('diff, then full file, then back to the diff: the pending note stays under line 40', () => {
    const asDiff = renderToStaticMarkup(<DiffLines path="server/x.ts" body={chunkFromFilePatch('server/x.ts', hunk)!.body} review={review} />);
    noteUnderRow40(asDiff);
    expect(asDiff).not.toContain('data-anchor="new:1"');

    const asFull = renderToStaticMarkup(<DiffLines path="server/x.ts" body={chunkFromFilePatch('server/x.ts', full)!.body} review={review} />);
    noteUnderRow40(asFull);
    // The rows outside the changed block are there, and uncoloured.
    const row1 = /data-anchor="new:1" class="([^"]*)"/.exec(asFull)?.[1] ?? '';
    expect(row1).not.toBe('');
    expect(row1).not.toMatch(/emerald|red-/);
    expect(asFull).toContain('data-anchor="new:80"');

    noteUnderRow40(renderToStaticMarkup(<DiffLines path="server/x.ts" body={chunkFromFilePatch('server/x.ts', hunk)!.body} review={review} />));
  });

  test('a text file offers "Full file", a picture does not', () => {
    const text: DiffBundle = { branch: 'x', stat: [{ path: 'server/x.ts', additions: 1, deletions: 1, status: 'M' }], patch: hunk, truncated: false, revs: { base: BASE, head: HEAD } };
    expect(renderToStaticMarkup(<UnifiedDiff bundle={text} source={TASK} focusPath="server/x.ts" />)).toContain('data-testid="diff-view-full"');
    const picture = binaryBundle({ path: 'a.png', additions: -1, deletions: -1, status: 'M' });
    expect(renderToStaticMarkup(<UnifiedDiff bundle={picture} source={TASK} focusPath="a.png" />)).not.toContain('diff-view-full');
  });
});

describe('the per-file row cap never hides a note or the change itself (DIFFPV-04)', () => {
  const N = 2000;
  const header = 'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n';
  /** "Full file" of a 2000-line file whose one change is on line `at`. */
  const wholeFile = (at: number) =>
    `${header}@@ -1,${N} +1,${N} @@\n${Array.from({ length: N }, (_, i) => (i === at - 1 ? `-line ${at}\n+line ${at} changed` : ` line ${i + 1}`)).join('\n')}\n`;
  const bodyOf = (patch: string) => chunkFromFilePatch('big.ts', patch)!.body;

  test('a note anchored past the cap is drawn under its row', () => {
    const note: DiffNote = { id: 'n', path: 'big.ts', line: 1500, side: 'new', code: ' line 1500', body: 'NOTE-ON-1500' };
    const html = renderToStaticMarkup(
      <DiffLines path="big.ts" body={bodyOf(wholeFile(5))} review={{ notes: [note], onAddNote: () => {}, onRemoveNote: () => {} }} />,
    );
    expect(html).toContain('data-anchor="new:1500"');
    expect(html).toContain('NOTE-ON-1500');
  });

  test('a whole file whose change sits past the cap opens on all of it, not on 600 rows of context', () => {
    const html = renderToStaticMarkup(<DiffLines path="big.ts" body={bodyOf(wholeFile(1500))} />);
    expect(html).toContain('+line 1500 changed');
  });

  test('with the change near the top and no note down there, the cap still holds', () => {
    const html = renderToStaticMarkup(<DiffLines path="big.ts" body={bodyOf(wholeFile(5))} />);
    expect(html).toContain('+line 5 changed');
    expect(html).not.toContain('data-anchor="new:1500"');
  });
});
