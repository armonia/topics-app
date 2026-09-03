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
import { projectGlyphSlotShown } from './rowLeadGlyph';

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
  test('the chat row reserves NOTHING: its name starts at the row padding', () => {
    // REVERSED ON 29/08. allow-italian: «vedo ancora spazio prima delle label nelle tab della sidebar»
    // The empty box bought one shared name column at the cost of
    // `ROW_GLYPH_SLOT` plus one gap of dead air on every chat - and the air is
    // what is actually looked at all day. The trade is now made the other way;
    // the rows that DO draw a glyph still use the shared slot, so the column
    // they form is unchanged.
    const reserved = source('TopicItem.tsx').match(/data-row-glyph-slot="empty"/g) ?? [];
    expect(
      reserved.length,
      'the chat row must not reserve an empty leading box: that box IS the ' +
        `${widthPx(ROW_GLYPH_SLOT)}px of space in front of the label.`,
    ).toBe(0);
  });

  test('a project without a favicon reserves NOTHING either', () => {
    // REVERSED ON 03/09 (card 058ea722), with a screenshot: "the text and
    // the accordion have a lot of useless space in between; it should be the
    // minimum, and move only when there is the icon". The empty 18px box a
    // project row kept when its folder ships no icon was that space. The
    // rule is a pure function, and this is its whole truth table.
    expect(projectGlyphSlotShown('none')).toBe(false);
    expect(projectGlyphSlotShown('has')).toBe(true);
    // In flight: the place is held for one round trip, so the name does not
    // jump left when the answer lands.
    expect(projectGlyphSlotShown('probing')).toBe(true);

    // And the project row actually goes through that rule: the slot lives in
    // its own component, gated on the store's answer, and TopicTree draws
    // that component instead of an unconditional box.
    const slot = source('ProjectGlyphSlot.tsx');
    expect(slot.includes('projectGlyphSlotShown(status)'), 'ProjectGlyphSlot.tsx must gate its box on projectGlyphSlotShown').toBe(true);
    expect(source('TopicTree.tsx').includes('<ProjectGlyphSlot'), 'TopicTree.tsx must draw the favicon through ProjectGlyphSlot').toBe(true);
    expect(
      (source('TopicTree.tsx').match(/data-row-glyph-slot="favicon"/g) ?? []).length,
      'no unconditional favicon box may be left in TopicTree.tsx',
    ).toBe(0);
  });

  test('a pinned tile in row form keeps no placeholder for a missing icon', () => {
    // The 14px blank that kept an icon-less project tile in the column of the
    // tiles with an icon is the same empty box, one surface over (card
    // 058ea722: "stessa cosa anche per le pinned"). allow-italian: quoted report
    expect(
      source('PinnedTile.tsx').includes('w-[14px]'),
      'PinnedTile.tsx still draws the 14px placeholder for a tile without an icon',
    ).toBe(false);
  });

  test('no leading glyph is drawn outside the shared slot', () => {
    // The project favicon was the last one. It sat in a 14px box of its own,
    // which put a project name 4px left of a board / terminal / browser name:
    // four pixels between neighbouring rows is not a difference anybody can
    // name, which is exactly what makes a column look crooked.
    const src = source('ProjectGlyphSlot.tsx');
    const favicon = /<ProjectFavicon\b/.exec(src);
    expect(favicon, 'the project favicon disappeared from ProjectGlyphSlot.tsx').not.toBeNull();
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
