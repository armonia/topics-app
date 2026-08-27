/**
 * @covers PINALIGN-01
 */
import { describe, expect, test } from 'bun:test';
import { ROW_GLYPH_SLOT } from '../../lib/selectionStyles';
import { PINNED_ALIGN, pinnedForm } from './pinnedTileMetrics';

/**
 * FORM AND ALIGNMENT ARE ONE DECISION, and this file is what makes that a fact
 * instead of a sentence in a comment.
 *
 * Reported on 27/08/2026: pinned tiles look pushed to the right when the
 * sidebar has spare width, and stacked tiles do not read as centred. The shape
 * (row or grid) was already decided in one place, the grid; the ALIGNMENT was
 * decided nowhere, so it lived scattered across the class lists of the tile and
 * nothing could turn red when the two drifted. The geometry itself is measured
 * in `tests/e2e/sidebar-pinned-alignment.spec.ts`, on the real DOM at three
 * sidebar widths; here we keep the RULE honest, which is a different question
 * and much cheaper to ask.
 */
describe('pinned tiles: the form decides the alignment', () => {
  test('one tile on the row is a row, two or more are a grid', () => {
    expect(pinnedForm(1)).toBe('row');
    expect(pinnedForm(2)).toBe('grid');
    expect(pinnedForm(3)).toBe('grid');
    expect(pinnedForm(5)).toBe('grid');
    // A row being drawn with no cell yet (the ghost of a new row) is still a
    // row: it is about to hold exactly one tile.
    expect(pinnedForm(0)).toBe('row');
  });

  test('a row aligns to the column, a grid tile centres its identity', () => {
    expect(PINNED_ALIGN.row.justify).toBe('justify-start');
    expect(PINNED_ALIGN.grid.justify).toBe('justify-center');
  });

  test('in row form the icon sits in the SHARED box of the column', () => {
    // Not a copy of the same numbers: the very constant the rows of the tree
    // use. Sized on the glyph instead (14 against the column's 18) the tile
    // put its name in a fourth column of its own, which is the defect
    // ROW_GLYPH_SLOT was written to close in the tree.
    expect(PINNED_ALIGN.row.iconSlot).toBe(ROW_GLYPH_SLOT);
  });

  test('in grid form nothing is reserved on the leading side', () => {
    // A fixed box wider than what it holds, or an empty accordion box, is air
    // on one side only: that asymmetry IS "pushed to the right".
    expect(PINNED_ALIGN.grid.iconSlot).not.toContain('w-[');
    expect(PINNED_ALIGN.grid.reservesChevron).toBe(false);
    expect(PINNED_ALIGN.row.reservesChevron).toBe(true);
  });
});
