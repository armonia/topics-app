/**
 * THE CARD'S CHANGED-FILES CHIP: the number it shows, and what a row does.
 *
 * Two defects measured on real data, both invisible to the type checker:
 *  · the chip said the DB counter while the list under it was the real diff
 *    (task 1c19bf48: 101 on the chip, 34 in the list). Once the list is read,
 *    the list is the truth;
 *  · the rows were text: the chip said which files and there was no way to
 *    read one. With `onOpen` a row opens the task on that file's diff.
 *
 * (No DOM in this repo: `renderToStaticMarkup`, as in `ThreadRuns.test.tsx`.
 * The click path is the e2e's job, `tests/e2e/changed-files-complete.spec.ts`.)
 *
 * @covers GIT-FILELIST-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { deliveryMeasure } from '../../lib/gitVisibility';
import { diffFocusFor, diffFocusPath, mediaPaneIdFor } from './constants';
import { ChangedFileList } from '../Git/ChangedFileList';
import type { DiffFileStat } from '../../lib/board';

const stat = (path: string, additions: number, deletions: number): DiffFileStat =>
  ({ path, additions, deletions, status: 'M' });

describe('the number on the chip', () => {
  test('before the list is read, the delivery counter is all there is', () => {
    expect(deliveryMeasure({ files: 101, insertions: 900, deletions: 40 }, null))
      .toEqual({ files: 101, insertions: 900, deletions: 40 });
  });

  test('once the list is read, the chip says what the list has, not the stale counter', () => {
    const read = [stat('a.ts', 10, 2), stat('b.ts', 3, 0), stat('c.png', -1, -1)];
    expect(deliveryMeasure({ files: 101, insertions: 900, deletions: 40 }, read))
      // A binary counts as a file, and its `-1` is not subtracted.
      .toEqual({ files: 3, insertions: 13, deletions: 2 });
  });

  test('a live turn with nothing counted yet has no number, then the read one', () => {
    expect(deliveryMeasure({ files: null, insertions: 0, deletions: 0 }, null)).toBeNull();
    expect(deliveryMeasure({ files: null, insertions: 0, deletions: 0 }, [stat('x.ts', 1, 1)]))
      .toEqual({ files: 1, insertions: 1, deletions: 1 });
  });
});

describe('a row opens the file in the task', () => {
  test('the focus id names a FILE of the diff, and a pane id is not mistaken for one', () => {
    expect(diffFocusPath(diffFocusFor('client/src/a b.ts'))).toBe('client/src/a b.ts');
    expect(diffFocusPath(mediaPaneIdFor('shot.png'))).toBeNull();
    expect(diffFocusPath(undefined)).toBeNull();
  });

  test('the chip hands its rows a handler, so they render as buttons', () => {
    // The chip passes `onOpen` down to the shared list only when it has one:
    // read on the source, because the chip itself opens its list on a click.
    const src = readFileSync(join(import.meta.dir, 'DeliveryFiles.tsx'), 'utf8');
    expect(src).toMatch(/<ChangedFileList[\s\S]*?onOpen=\{openRow\}/);
    expect(src).toMatch(/onOpen\(taskId, diffFocusFor\(row\.path\)\)/);
    const card = readFileSync(join(import.meta.dir, 'Card.tsx'), 'utf8');
    expect(card).toMatch(/<DeliveryFiles[\s\S]*?onOpen=\{onOpen\}[\s\S]*?\/>/);
    // And a list with a handler draws buttons.
    const html = renderToStaticMarkup(<ChangedFileList rows={[{ path: 'a.ts', status: 'modified' }]} onOpen={() => {}} />);
    expect(html).toContain('<button');
  });

  test('the drawer reads the diff focus: delivery band open, workspace closed, file handed to «Modifiche»', () => {
    const src = readFileSync(join(import.meta.dir, 'TaskDetail.tsx'), 'utf8');
    expect(src).toContain('const focusDiff = diffFocusPath(focusPaneId);');
    expect(src).toContain('useState(!!focusDiff)');
    expect(src).toMatch(/<TaskChangesSection[^>]*focusPath=\{focusDiff\}/);
    expect(src).toMatch(/<UnifiedDiff bundle=\{bundle\}[^>]*focusPath=\{focusPath\}/);
  });
});
