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
 * (No DOM in this repo's unit runner. What one render shows is read with
 * `renderToStaticMarkup`; what a click or a re-read bundle changes goes
 * through `test/reactHarness`, which renders the real component again and
 * hands back the `onClick` it drew, with `boardApi.diffFile` answering in
 * place of the server.)
 *
 * @covers KANBAN-43, DIFFPV-02, DIFFPV-03, DIFFPV-04, DIFFPV-05
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffLines, UnifiedDiff, type DiffReview } from './UnifiedDiff';
import { chunkFromFilePatch } from './diffFileRows';
import MarkdownPreview from '../Editor/MarkdownPreview';
import { boardApi, type DiffBundle, type DiffFileStat, type DiffPanelSource } from '../../lib/board';
import type { DiffNote } from './reviewNotes';
import { mount, type Harness } from '../../test/reactHarness';

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

/** One modified text file, its patch in the bundle. */
function textBundle(path: string, patch: string): DiffBundle {
  return { branch: 'x', stat: [{ path, additions: 1, deletions: 1, status: 'M' }], patch, truncated: false, revs: { base: BASE, head: HEAD } };
}

type PanelProps = { review?: DiffReview; focusPath?: string; defaultOpenFirst?: boolean; onStale?: () => void };

/** The panel mounted from scratch, and a way to hand it a re-read bundle as the drawer does. */
function mountDiff(first: DiffBundle, props: PanelProps) {
  let bundle = first;
  const h = mount(<UnifiedDiffOf bundle={() => bundle} {...props} />);
  return { h, setBundle: (next: DiffBundle) => { bundle = next; h.rerender(); } };
}

function UnifiedDiffOf({ bundle, ...props }: { bundle: () => DiffBundle } & PanelProps) {
  return <UnifiedDiff bundle={bundle()} source={TASK} {...props} />;
}

type FileCall = { path: string; opts?: { full?: boolean; origPath?: string } };

/** The per-file route, answered by `patchOf`; every call is recorded. */
function answerFiles(patchOf: (path: string) => string) {
  const calls: FileCall[] = [];
  const spy = spyOn(boardApi, 'diffFile').mockImplementation(async (_source, path, opts) => {
    calls.push({ path, opts });
    return { path, patch: patchOf(path), truncated: false };
  });
  return { calls, restore: () => spy.mockRestore() };
}

/** The promises an effect started settle, and the renders they cause run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function click(h: Harness, testId: string) {
  const node = h.last().hosts.find((n) => n.props['data-testid'] === testId);
  if (!node) throw new Error(`${testId} is not drawn`);
  (node.props.onClick as () => void)();
}

/** A host node the last render drew, by its test id. */
const drawn = (h: Harness, testId: string) => h.last().hosts.find((n) => n.props['data-testid'] === testId);

const pressedView = (h: Harness) =>
  h.last().hosts.find((n) => n.props['aria-pressed'] === true)?.props['data-testid'] ?? null;

const anchorDrawn = (h: Harness, anchor: string) => h.last().hosts.some((n) => n.props['data-anchor'] === anchor);

/** The note `body` is drawn after the row `anchor` and before the row `next`. */
function noteUnder(h: Harness, anchor: string, body: string, next: string) {
  const hosts = h.last().hosts;
  const row = hosts.findIndex((n) => n.props['data-anchor'] === anchor);
  const at = hosts.findIndex((n) => n.props.children === body);
  const after = hosts.findIndex((n) => n.props['data-anchor'] === next);
  expect(row).toBeGreaterThan(-1);
  expect(at).toBeGreaterThan(row);
  expect(after).toBeGreaterThan(at);
}

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
    // `v=` is the blob id of the block's `index 1..2` line: which content of the file on disk.
    expect(srcOf(html, 'diff-image-after')).toBe('/api/boards/p/tasks/t/diff?file=new.png&amp;blob=worktree&amp;v=2');
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

  test('DiffLines draws the note under its row both with the block context and with the whole file', () => {
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
  });

  test('diff, then full file, then back to the diff: the pending note stays under line 40', async () => {
    const files = answerFiles(() => full);
    const { h } = mountDiff(textBundle('server/x.ts', hunk), { review, focusPath: 'server/x.ts' });
    try {
      expect(pressedView(h)).toBe('diff-view-diff');
      noteUnder(h, 'new:40', 'NOTE-ON-40', 'new:41');
      expect(anchorDrawn(h, 'new:1')).toBe(false);

      click(h, 'diff-view-full');
      await settle();
      expect(files.calls).toEqual([{ path: 'server/x.ts', opts: { full: true, origPath: undefined } }]);
      expect(pressedView(h)).toBe('diff-view-full');
      expect(anchorDrawn(h, 'new:1')).toBe(true);
      noteUnder(h, 'new:40', 'NOTE-ON-40', 'new:41');

      click(h, 'diff-view-diff');
      expect(anchorDrawn(h, 'new:1')).toBe(false);
      noteUnder(h, 'new:40', 'NOTE-ON-40', 'new:41');
    } finally {
      h.unmount();
      files.restore();
    }
  });

  test('a text file offers "Full file", a picture does not', () => {
    const text: DiffBundle = { branch: 'x', stat: [{ path: 'server/x.ts', additions: 1, deletions: 1, status: 'M' }], patch: hunk, truncated: false, revs: { base: BASE, head: HEAD } };
    expect(renderToStaticMarkup(<UnifiedDiff bundle={text} source={TASK} focusPath="server/x.ts" />)).toContain('data-testid="diff-view-full"');
    const picture = binaryBundle({ path: 'a.png', additions: -1, deletions: -1, status: 'M' });
    expect(renderToStaticMarkup(<UnifiedDiff bundle={picture} source={TASK} focusPath="a.png" />)).not.toContain('diff-view-full');
  });
});

describe('a note written in "Full file" off the changed blocks (DIFFPV-04)', () => {
  // A 12-line file whose one block covers lines 6-12: line 1 exists only in "Full file".
  const header = 'diff --git a/server/y.ts b/server/y.ts\n--- a/server/y.ts\n+++ b/server/y.ts\n';
  const hunk = `${header}@@ -6,7 +6,7 @@\n line 6\n line 7\n line 8\n-line 9\n+line 9 changed\n line 10\n line 11\n line 12\n`;
  const whole = `${header}@@ -1,12 +1,12 @@\n${Array.from({ length: 12 }, (_, i) => (i === 8 ? '-line 9\n+line 9 changed' : ` line ${i + 1}`)).join('\n')}\n`;
  const note: DiffNote = { id: 'n1', path: 'server/y.ts', line: 1, side: 'new', code: ' line 1', body: 'NOTE-ON-1' };
  const review = { notes: [note], onAddNote: () => {}, onRemoveNote: () => {} };

  test('the panel mounted from scratch opens that file on the whole file, with the note under its row', async () => {
    const files = answerFiles(() => whole);
    const { h } = mountDiff(textBundle('server/y.ts', hunk), { review });
    try {
      expect(pressedView(h)).toBe('diff-view-full');
      await settle();
      expect(files.calls).toEqual([{ path: 'server/y.ts', opts: { full: true, origPath: undefined } }]);
      noteUnder(h, 'new:1', 'NOTE-ON-1', 'new:2');
    } finally {
      h.unmount();
      files.restore();
    }
  });

  test('a file whose patch did not arrive and holds a note opens on the whole file too', () => {
    const bundle: DiffBundle = { ...textBundle('server/y.ts', ''), truncated: true };
    const html = renderToStaticMarkup(<UnifiedDiff bundle={bundle} source={TASK} review={review} />);
    expect(html).toMatch(/data-testid="diff-view-full" aria-pressed="true"/);
  });

  test('a note on a row of the diff leaves it on the diff, and a choice made by hand wins', () => {
    const onBlock: DiffNote = { ...note, line: 9, code: '+line 9 changed' };
    const html = renderToStaticMarkup(
      <UnifiedDiff bundle={textBundle('server/y.ts', hunk)} source={TASK} review={{ ...review, notes: [onBlock] }} />,
    );
    expect(html).toMatch(/data-testid="diff-view-diff" aria-pressed="true"/);

    const files = answerFiles(() => whole);
    const { h } = mountDiff(textBundle('server/y.ts', hunk), { review });
    try {
      click(h, 'diff-view-diff');
      expect(pressedView(h)).toBe('diff-view-diff');
    } finally {
      h.unmount();
      files.restore();
    }
  });
});

describe('every per-file read of a renamed file names its old path (DIFFPV-04)', () => {
  const renamed: DiffFileStat = { path: 'docs/nuovo.txt', additions: 1, deletions: 1, status: 'R090', origPath: 'docs/vecchio.txt' };
  const renamePatch = 'diff --git a/docs/vecchio.txt b/docs/nuovo.txt\nsimilarity index 90%\nrename from docs/vecchio.txt\nrename to docs/nuovo.txt\n--- a/docs/vecchio.txt\n+++ b/docs/nuovo.txt\n@@ -9 +9 @@\n-riga 9\n+riga 9 cambiata\n';
  const bundleOf = (patch: string, truncated = false): DiffBundle => ({ branch: 'x', stat: [renamed], patch, truncated, revs: { base: BASE, head: HEAD } });

  test('"Full file"', async () => {
    const files = answerFiles(() => renamePatch);
    const { h } = mountDiff(bundleOf(renamePatch), { focusPath: 'docs/nuovo.txt' });
    try {
      click(h, 'diff-view-full');
      await settle();
      expect(files.calls).toEqual([{ path: 'docs/nuovo.txt', opts: { full: true, origPath: 'docs/vecchio.txt' } }]);
    } finally {
      h.unmount();
      files.restore();
    }
  });

  test('the patch of a file left past the bundle cap, loaded by hand or on focus', async () => {
    const files = answerFiles(() => renamePatch);
    const byHand = mountDiff(bundleOf('', true), { defaultOpenFirst: true });
    try {
      click(byHand.h, 'diff-load-file');
      await settle();
      expect(files.calls).toEqual([{ path: 'docs/nuovo.txt', opts: { origPath: 'docs/vecchio.txt' } }]);
    } finally {
      byHand.h.unmount();
    }
    const onFocus = mountDiff(bundleOf('', true), { focusPath: 'docs/nuovo.txt' });
    try {
      await settle();
      expect(files.calls[1]).toEqual({ path: 'docs/nuovo.txt', opts: { origPath: 'docs/vecchio.txt' } });
    } finally {
      onFocus.h.unmount();
      files.restore();
    }
  });
});

describe('a live worktree re-read moves every view along (DIFFPV-03, DIFFPV-04)', () => {
  const LIVE = { base: BASE, head: null };
  const block = (path: string, text: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${text}\n`;
  const liveBundle = (path: string, text: string): DiffBundle => ({ ...textBundle(path, block(path, text)), revs: LIVE });

  test('"Full file" is read again when the block changes or the revisions move, not on an identical re-read', async () => {
    let n = 0;
    const files = answerFiles(() => block('x.ts', `full ${++n}`));
    const { h, setBundle } = mountDiff(liveBundle('x.ts', 'one'), { focusPath: 'x.ts' });
    try {
      click(h, 'diff-view-full');
      await settle();
      expect(files.calls).toHaveLength(1);
      expect(h.last().text).toContain('+full 1');

      setBundle(liveBundle('x.ts', 'one'));
      await settle();
      expect(files.calls).toHaveLength(1);

      setBundle(liveBundle('x.ts', 'two'));
      await settle();
      expect(files.calls).toHaveLength(2);
      expect(h.last().text).toContain('+full 2');

      setBundle({ ...liveBundle('x.ts', 'two'), revs: { base: BASE, head: HEAD } });
      await settle();
      expect(files.calls).toHaveLength(3);
    } finally {
      h.unmount();
      files.restore();
    }
  });

  // A block as git writes it: `index <before>..<after>`, the After being the
  // blob id git computed for the file on disk.
  const svgBlock = (after: string) =>
    `diff --git a/d.svg b/d.svg\nindex 1111111..${after} 100644\n--- a/d.svg\n+++ b/d.svg\n@@ -1 +1 @@\n-<svg/>\n+<svg id="${after}"/>\n`;
  const pngBlock = (after: string) =>
    `diff --git a/x.png b/x.png\nindex 1111111..${after} 100644\nBinary files a/x.png and b/x.png differ\n`;

  test('the rendered .svg reads new bytes when its block changes, and the same bytes on an identical re-read', () => {
    const svg = (after: string): DiffBundle => ({ ...textBundle('d.svg', svgBlock(after)), revs: LIVE });
    const { h, setBundle } = mountDiff(svg('2222222'), { focusPath: 'd.svg' });
    try {
      click(h, 'diff-view-preview');
      // Same URL, same picture: a page keeps an image it already loaded under
      // that URL, whatever the response said about caching.
      expect(drawn(h, 'diff-svg-preview')?.props.src).toBe('/api/boards/p/tasks/t/diff?file=d.svg&blob=worktree&v=2222222');
      setBundle(svg('2222222'));
      expect(drawn(h, 'diff-svg-preview')?.props.src).toBe('/api/boards/p/tasks/t/diff?file=d.svg&blob=worktree&v=2222222');
      setBundle(svg('3333333'));
      expect(drawn(h, 'diff-svg-preview')?.props.src).toBe('/api/boards/p/tasks/t/diff?file=d.svg&blob=worktree&v=3333333');
    } finally {
      h.unmount();
    }
  });

  test("a picture's After on the worktree follows its block too; its Before, at a SHA, never changes", () => {
    const png = (after: string): DiffBundle =>
      ({ ...binaryBundle({ path: 'x.png', additions: -1, deletions: -1, status: 'M' }, LIVE), patch: pngBlock(after) });
    const { h, setBundle } = mountDiff(png('2222222'), { focusPath: 'x.png' });
    try {
      expect(drawn(h, 'diff-image-after')?.props.src).toBe('/api/boards/p/tasks/t/diff?file=x.png&blob=worktree&v=2222222');
      setBundle(png('3333333'));
      expect(drawn(h, 'diff-image-after')?.props.src).toBe('/api/boards/p/tasks/t/diff?file=x.png&blob=worktree&v=3333333');
      expect(drawn(h, 'diff-image-before')?.props.src).toBe(`/api/boards/p/tasks/t/diff?file=x.png&blob=${BASE}`);
    } finally {
      h.unmount();
    }
  });

  test('the rendered .md is read again when its block changes, not on an identical re-read', async () => {
    const asked: string[] = [];
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      if (String(url).includes('blob=')) asked.push(String(url));
      return new Response('# Title');
    }) as unknown as typeof fetch);
    const { h, setBundle } = mountDiff(liveBundle('README.md', 'one'), { focusPath: 'README.md' });
    try {
      click(h, 'diff-view-preview');
      await settle();
      expect(asked).toEqual(['/api/boards/p/tasks/t/diff?file=README.md&blob=worktree']);

      setBundle(liveBundle('README.md', 'one'));
      await settle();
      expect(asked).toHaveLength(1);

      setBundle(liveBundle('README.md', 'two'));
      await settle();
      expect(asked).toHaveLength(2);
    } finally {
      h.unmount();
      spy.mockRestore();
    }
  });
});

describe('a byte read the bundle moved past re-reads the bundle, from the panel (DIFFPV-05)', () => {
  /** Every byte read answers 409, as after a land between the list and the click. */
  function answerStale() {
    const asked: string[] = [];
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response(null, { status: 409 });
    }) as unknown as typeof fetch);
    return { asked, restore: () => spy.mockRestore() };
  }

  test('a picture that does not load asks why, and on a 409 its owner re-reads the bundle once', async () => {
    const server = answerStale();
    let rereads = 0;
    const { h } = mountDiff(binaryBundle({ path: 'assets/logo.png', additions: -1, deletions: -1, status: 'M' }), {
      focusPath: 'assets/logo.png',
      onStale: () => { rereads++; },
    });
    try {
      const img = drawn(h, 'diff-image-after');
      if (!img) throw new Error('diff-image-after is not drawn');
      (img.props.onError as () => void)();
      await settle();
      expect(server.asked).toEqual([`/api/boards/p/tasks/t/diff?file=assets%2Flogo.png&blob=${HEAD}`]);
      expect(rereads).toBe(1);
      expect(drawn(h, 'diff-image-unavailable')).toBeDefined();
    } finally {
      h.unmount();
      server.restore();
    }
  });

  test('a README whose rendered side answers 409 has its owner re-read the bundle', async () => {
    const server = answerStale();
    let rereads = 0;
    const { h } = mountDiff(textBundle('README.md', patchFor('README.md')), {
      focusPath: 'README.md',
      onStale: () => { rereads++; },
    });
    try {
      click(h, 'diff-view-preview');
      await settle();
      expect(server.asked).toEqual([`/api/boards/p/tasks/t/diff?file=README.md&blob=${HEAD}`]);
      expect(rereads).toBe(1);
    } finally {
      h.unmount();
      server.restore();
    }
  });
});

describe('a delivered .md, rendered, runs nothing and navigates nowhere (DIFFPV-03)', () => {
  const readme = [
    '# Title',
    '',
    '<iframe srcdoc="<script>parent.document.title=1</script>"></iframe>',
    '',
    '<script>parent.document.title=2</script>',
    '',
    '<object data="x.html"></object><embed src="x.html">',
    '',
    '<form action="https://example.test/"><button>go</button></form>',
    '',
    '<base href="https://example.test/">',
    '',
    '<details><summary>More</summary>kept</details>',
    '',
    '[contributing](CONTRIBUTING.md) and [the site](https://example.test/docs)',
    '',
  ].join('\n');

  test('no element that runs code, loads a document or rewires the page reaches the DOM', () => {
    const html = renderToStaticMarkup(<MarkdownPreview content={readme} baseDir="" resolveImage={() => null} untrusted />);
    for (const tag of ['<iframe', '<script', '<object', '<embed', '<form', '<base']) expect(html).not.toContain(tag);
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toContain('<details><summary>More</summary>kept</details>');
  });

  test('what it draws stays inside the preview: the box contains every fixed or absolute box of the file', () => {
    // A `style` or one of the app's own classes (`fixed inset-0`) would
    // otherwise lay a box over the whole window, above the drawer and its buttons.
    const html = renderToStaticMarkup(
      <MarkdownPreview
        content={'<div style="position:fixed;inset:0;z-index:2147483647">OVERLAY</div>\n\n<div class="fixed inset-0">CLASSED</div>\n'}
        baseDir=""
        resolveImage={() => null}
        untrusted
      />,
    );
    // Paint containment makes the preview the containing block of those boxes,
    // their stacking context, and their clip.
    expect(html).toMatch(/^<div class="[^"]*\bcontain-paint\b[^"]*">.*OVERLAY.*CLASSED/s);
  });

  test('a relative link stays text, a web link is a link', () => {
    const html = renderToStaticMarkup(<MarkdownPreview content={readme} baseDir="" resolveImage={() => null} untrusted />);
    expect(html).not.toMatch(/<a [^>]*href="CONTRIBUTING\.md"/);
    expect(html).toContain('contributing');
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.test\/docs"/);
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
