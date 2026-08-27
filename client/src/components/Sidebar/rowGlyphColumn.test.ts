/**
 * ONE NAME COLUMN FOR THE WHOLE SIDEBAR, and it is read from the source.
 *
 * The report on the board (card 018fd91f): after the accordion column was made
 * one, the list still carried THREE name columns. Measured in the live sidebar
 * at its default 256px: a chat name started 34px from the sidebar edge, a
 * project name at 56 (its favicon sat in a 14px box of its own, the last glyph
 * outside the shared slot), a board / utility / terminal / browser name at 60.
 *
 * The cause is the same shape as the chevron one, one column to the right: a
 * row that draws no leading glyph reserved no box for it. Not DRAWING a glyph
 * on a chat and not RESERVING its box are two separate decisions, and only the
 * first had ever been taken.
 *
 * WHY A SOURCE TEST AND NOT A RENDER. Measuring `getBoundingClientRect().left`
 * needs layout, and layout needs a browser: jsdom/happy-dom are deliberately
 * not dependencies here (see `client/src/test/reactHarness.ts`). The live
 * measurement exists and runs in a real browser:
 * `tests/e2e/sidebar-name-column.spec.ts` reads the `left` of every sidebar
 * name and demands ONE value per depth. What this file adds is the part a
 * browser cannot check cheaply: the STRUCTURE that produces the single column,
 * on every row family, including the ones no fixture happens to render.
 *
 * @covers LAYOUT-27
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROW_GLYPH, ROW_GLYPH_SLOT } from '../../lib/selectionStyles';

/** Tailwind's spacing scale: `n` is `n x 0.25rem`, i.e. `n x 4px`. */
const STEP_PX = 4;

/** The pixels a class of the shape `w-3` / `w-[18px]` is worth. */
function widthPx(classes: string): number {
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const m = /^w-(?:\[(\d+)px\]|(\d+))$/.exec(cls);
    if (!m) continue;
    return m[1] !== undefined ? Number(m[1]) : Number(m[2]) * STEP_PX;
  }
  throw new Error(`no 'w-' measure readable in "${classes}"`);
}

const HERE = import.meta.dir;

function source(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

describe('the leading-glyph column of the sidebar', () => {
  test('the chat row reserves the glyph box although it draws nothing in it', () => {
    // The row family the card is about. A chat carries NO mark of its own (the
    // Claude / Codex marks belong to real agent sessions, never to a chat) and
    // that decision is untouched: what it reserves is the BOX, empty, so its
    // name starts where every other name starts.
    const reserved = source('TopicItem.tsx').match(/data-row-glyph-slot="empty"/g) ?? [];
    expect(
      reserved.length,
      'TopicItem.tsx must reserve the leading-glyph box on the chat row: without it ' +
        `a chat name starts ${widthPx(ROW_GLYPH_SLOT)}px plus one row gap left of a ` +
        'project name, and the sidebar carries two name columns.',
    ).toBe(1);
  });

  test('no leading glyph is drawn outside the shared slot', () => {
    // The project favicon was the last one. It sat in a 14px box of its own,
    // which put a project name 4px left of a board / terminal / browser name:
    // four pixels between neighbouring rows is not a difference anybody can
    // name, which is exactly what makes a column look crooked.
    const src = source('TopicTree.tsx');
    const favicon = /<ProjectFavicon\b/.exec(src);
    expect(favicon, 'the project favicon disappeared from TopicTree.tsx').not.toBeNull();
    const before = src.slice(0, favicon?.index ?? 0);
    const enclosing = before.lastIndexOf('<span');
    expect(
      before.slice(enclosing).includes('ROW_GLYPH_SLOT'),
      'the project favicon must be wrapped in the shared ROW_GLYPH_SLOT box, not in a ' +
        'hand-written one: it is the box that aligns the column, not the ink.',
    ).toBe(true);
  });

  test('the slot is wider than the glyph it holds, and by the same margin for all', () => {
    // A slot narrower than the drawing would be overflowed by it and the column
    // would move with the widest glyph rendered that day.
    expect(widthPx(ROW_GLYPH_SLOT)).toBeGreaterThanOrEqual(ROW_GLYPH);
  });

  test('the reserved box centres what it holds, so the column does not depend on the drawing', () => {
    expect(
      /(^|\s)justify-center(\s|$)/.test(ROW_GLYPH_SLOT),
      `the shared glyph box must centre its content ("${ROW_GLYPH_SLOT}"): a glyph ` +
        'narrower than the slot would otherwise sit at a different x on every family.',
    ).toBe(true);
  });

  test('the name of a chat and the name of a project are both measurable', () => {
    // The e2e reads `[data-row-name]`. If the marker is dropped as decoration
    // the live guard goes quietly green on an empty set, which is the failure
    // mode the chevron column already paid for once.
    expect(source('TopicItem.tsx')).toContain('data-row-name="chat"');
    expect(source('TopicTree.tsx')).toContain('data-row-name="project"');
  });
});
