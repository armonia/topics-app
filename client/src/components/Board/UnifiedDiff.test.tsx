/**
 * A FILE PAST THE PAYLOAD CAP CAN BE READ, AND A FOCUSED FILE IS OPEN.
 *
 * The bundle stops at ~200 KB, and every file past it showed «patch non
 * arrivato» with nothing to click (task 7657f201: 30 of 74). Now a task diff
 * offers to fetch that one file (`GET …/diff?file=`, pinned in
 * `server/routes/tasks.diff-panel.test.ts`); a publish diff, which has no task
 * to ask, keeps the plain notice.
 *
 * @covers KANBAN-43
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnifiedDiff } from './UnifiedDiff';
import { chunkFromFilePatch } from './diffFileRows';
import type { DiffBundle } from '../../lib/board';

const patchFor = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

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

describe('a file the bundle left out', () => {
  test('on a task diff, the missing file offers to load its own patch', () => {
    const html = renderToStaticMarkup(<UnifiedDiff bundle={cut} projectId="p" taskId="t" focusPath="z.ts" />);
    expect(html).toContain('data-testid="diff-load-file"');
  });

  test('without a task to ask (a publish diff) the notice stays plain', () => {
    const html = renderToStaticMarkup(<UnifiedDiff bundle={cut} focusPath="z.ts" />);
    expect(html).not.toContain('diff-load-file');
  });

  test('the per-file answer is split to the chunk of THAT file', () => {
    expect(chunkFromFilePatch('z.ts', patchFor('z.ts'))?.body).toContain('+new');
    expect(chunkFromFilePatch('z.ts', '')).toBeNull();
  });
});

describe('the file the panel was opened on', () => {
  test('is marked and expanded, the others stay closed', () => {
    const html = renderToStaticMarkup(<UnifiedDiff bundle={{ ...cut, truncated: false, patch: patchFor('a.ts') + patchFor('z.ts') }} focusPath="z.ts" />);
    expect(html).toMatch(/data-path="z\.ts" data-focused="1"/);
    expect(html).not.toMatch(/data-path="a\.ts" data-focused/);
    // Expanded: its lines are in the document. `a.ts` is closed, so only one
    // `+new` is drawn.
    expect(html.match(/\+new/g)).toHaveLength(1);
  });
});
