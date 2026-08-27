/**
 * ONE SPLIT SCHEMATIC FOR THE WHOLE SIDEBAR, and it is read from the source.
 *
 * The report on the board: the split preview appears on some sidebar rows and
 * not on others. Measured before this file: the schematic was written out three
 * times, in the chat row, in the terminal row and in a project-only copy, so
 * three row families answered "where does this pane sit" and three did not -
 * browser, utility and the board row, which is the sidebar's only presence for
 * the board pane. The project copy had also drifted to a trailing margin of its
 * own (`mr-1.5`) that no sister had, which is what a duplicated decision does
 * over time.
 *
 * WHY A SOURCE TEST AND NOT A RENDER. Reading the map on screen needs a split
 * grid, a layout and a real browser: `tests/e2e/split-screen-sync.spec.ts` and
 * friends live there. What a browser cannot check cheaply is the STRUCTURE that
 * makes the answer uniform - that every row family calls the ONE component, and
 * that nobody re-implements it next door. The list of families is the point: a
 * new row family added to one of these files turns this red, which is the
 * moment to decide whether it shows the position, not six months later when
 * somebody notices it never did.
 *
 * @covers LAYOUT-29
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dir;

/**
 * The sidebar row families that stand for an OPEN PANE, and therefore have to
 * be able to say where that pane sits in the split.
 */
const ROWS_WITH_A_PANE: Record<string, string[]> = {
  'TopicItem.tsx': ['chat row'],
  'TopicTree.tsx': ['utility row', 'project row', 'board row', 'terminal row', 'browser row'],
  // The tile only carries it in ROW form: in grid form it shows identity and
  // nothing else, on 40 to 100px of width (see `splitMap` in PINNED_ALIGN).
  'PinnedTile.tsx': ['pinned row'],
};

/** The one component that decides the map's source, tone and placement. */
const OWNER = 'RowSplitMap.tsx';

function source(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

describe('the split schematic of the sidebar', () => {
  test('every row family that stands for a pane renders it', () => {
    for (const [file, families] of Object.entries(ROWS_WITH_A_PANE)) {
      const used = source(file).match(/<RowSplitMap\b/g) ?? [];
      expect(
        used.length,
        `${file} should render the split schematic on ${families.length} row ` +
          `famil${families.length === 1 ? 'y' : 'ies'} (${families.join(', ')}), ` +
          `found ${used.length}. A row that stands for an open pane and does not ` +
          'show its cell reads as "this one is not in the split".',
      ).toBe(families.length);
    }
  });

  test('nobody draws it by hand next to the component that owns it', () => {
    for (const file of [...Object.keys(ROWS_WITH_A_PANE), 'PinnedTiles.tsx', 'SpaceGroups.tsx']) {
      const src = source(file);
      expect(
        /<SplitMiniMap\b/.test(src) || /useSplitPosition\s*\(/.test(src),
        `${file} reaches for the schematic directly. There is one component for ` +
          `it (${OWNER}): a second copy is how the project row ended up with a ` +
          'trailing margin its sisters did not have.',
      ).toBe(false);
    }
  });

  test('the component renders nothing when there is no split to orient against', () => {
    // A row must not pay a box, a gap or a title for a layout with one cell:
    // the early return is what makes "only when it means something" a fact.
    expect(/if\s*\(!pos\)\s*return null;/.test(source(OWNER))).toBe(true);
  });
});
