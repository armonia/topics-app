/**
 * ONE ACCORDION COLUMN FOR THE WHOLE SIDEBAR, and it is read from the source.
 *
 * The report on the board (card 150ebafb): a row without an accordion starts
 * further left than a row that has one, so two alignments live in one column.
 * The cause was not a
 * wrong number, it was a MISSING BOX: the chevron lived inside `{hasChildren &&
 * (...)}` with no else branch, so a row without children reserved nothing and
 * its label began `ROW_CHEVRON_SLOT` + `ROW_GAP` = 20px left of its sister's.
 *
 * WHY A SOURCE TEST AND NOT A RENDER. Measuring `getBoundingClientRect().left`
 * needs layout, and layout needs a browser: jsdom/happy-dom are deliberately
 * not dependencies here (see `client/src/test/reactHarness.ts`), and a fake
 * layout would measure the fake. The live measurement exists and runs in a real
 * browser: `tests/e2e/sidebar-chevron-column.spec.ts` reads the `left` of every
 * label of the column and demands ONE value per depth. What this file adds is
 * the part that a browser cannot check cheaply: the STRUCTURE that produces
 * that single column, on every row family, including the ones no fixture
 * happens to render.
 *
 * @covers LAYOUT-26
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROW_CHEVRON, ROW_CHEVRON_SLOT, ROW_GAP } from '../../lib/selectionStyles';

/** Tailwind's spacing scale: `n` is `n x 0.25rem`, i.e. `n x 4px`. */
const STEP_PX = 4;

/** The pixels a class of the shape `w-3` / `gap-2` / `w-[18px]` is worth. */
function px(classes: string, prop: 'w' | 'gap'): number {
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const m = new RegExp(`^${prop}-(?:\\[(\\d+)px\\]|(\\d+))$`).exec(cls);
    if (!m) continue;
    return m[1] !== undefined ? Number(m[1]) : Number(m[2]) * STEP_PX;
  }
  throw new Error(`no '${prop}-' measure readable in "${classes}"`);
}

const HERE = import.meta.dir;

/**
 * The row families of the sidebar that have NO accordion of their own, and
 * therefore have to reserve its box explicitly. The list is the point: a new
 * row family added to one of these files makes this test red, which is the
 * moment to decide where its content starts instead of discovering it later in
 * a column that no longer lines up.
 */
const RESERVED_BY_HAND: Record<string, string[]> = {
  'TopicItem.tsx': ['chat row without children'],
  'TopicTree.tsx': ['terminal row', 'browser row', 'utility row', 'board row'],
  // The pinned tile only reserves it in ROW form. In grid form the tile is
  // centred and the trigger's weight is mirrored, so an empty leading box would
  // push the identity off centre (see the comment at the call site).
  'PinnedTile.tsx': ['pinned row without accordion'],
};

function source(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

/** The text of every `{cond && (...)}` JSX block, with its condition. */
function guardedBlocks(src: string): { condition: string; body: string }[] {
  const blocks: { condition: string; body: string }[] = [];
  const opener = /\{\s*([^{}()]*?)&&\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push({ condition: m[1].trim(), body: src.slice(start, i + 1) });
  }
  return blocks;
}

describe('the accordion column of the sidebar', () => {
  test('no chevron slot lives inside a condition without an else branch', () => {
    for (const file of Object.keys(RESERVED_BY_HAND)) {
      for (const block of guardedBlocks(source(file))) {
        expect(
          block.body.includes('ROW_CHEVRON_SLOT'),
          `${file}: the accordion slot is rendered only when \`${block.condition}\` holds. ` +
            'A row that fails that condition then reserves nothing, and its content starts ' +
            `${px(ROW_CHEVRON_SLOT, 'w') + px(ROW_GAP, 'gap')}px left of its sisters. ` +
            'Use a ternary and render the empty box in the else branch.',
        ).toBe(false);
      }
    }
  });

  test('every row family without an accordion reserves its box', () => {
    for (const [file, families] of Object.entries(RESERVED_BY_HAND)) {
      const reserved = source(file).match(/data-row-chevron-slot="empty"/g) ?? [];
      expect(
        reserved.length,
        `${file} should reserve the accordion box on ${families.length} row ` +
          `famil${families.length === 1 ? 'y' : 'ies'} (${families.join(', ')}), ` +
          `found ${reserved.length}`,
      ).toBe(families.length);
    }
  });

  test('the reserved box declares a height, or nothing can see it', () => {
    // THE RATCHET UNDER 88a80f1aa. The empty branch is a span with no content:
    // with a width and no height it is 12x0, so it holds the column open and is
    // invisible to everything that reads the layout - the first measurable
    // child of the row becomes the NEXT one (18px on the Board row, 153px on a
    // chat), which is what the nightly of 27/08 measured, and a box of zero
    // height could never have taken a click either.
    //
    // The width is checked below and the class is shared by both branches, so
    // this is the half that has no other guard: a `self-stretch` deleted as
    // decoration puts ROWALIGN-01/02 back to red in a nightly, not here.
    expect(
      /(^|\s)(self-stretch|h-full|h-\[\d+px\]|h-\d+)(\s|$)/.test(ROW_CHEVRON_SLOT),
      `the reserved accordion box must declare a height ("${ROW_CHEVRON_SLOT}"): ` +
        'without one the empty branch is 12x0 and drops out of every measurement.',
    ).toBe(true);
  });

  test('the reserved box is the chevron box, not a second measure', () => {
    // If the empty box drifted from the box the chevron sits in, the column
    // would be back to two alignments - just with a smaller gap between them.
    expect(px(ROW_CHEVRON_SLOT, 'w')).toBe(ROW_CHEVRON);
  });
});
