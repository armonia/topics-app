/**
 * THE FOOT OF THE COLUMN LINES UP, and that is a measurement.
 *
 * The band used to be three subjects told apart by their FIRST GLYPH, and the
 * only way that works is if the glyphs occupy the same box: a face at 16px, an
 * org logo at 14 and a people mark at 10 are three different left edges. It was
 * crooked - measured on the delivery screenshot of 2026-08-21: 16px, 8px and
 * 11px tall, left edge jumping between x=6 and x=10.
 *
 * The band is now the chips of whoever is around plus the user card, which is
 * FEWER subjects and the same rule: a chip's face and the card's face are on
 * two lines that sit one under the other, so a size written by hand in either
 * place shows immediately.
 *
 * This test reads the SOURCE, not a render, on purpose: the fault was literals
 * written in several places, and a render test would go green again the moment
 * somebody typed one more. What is pinned here is that every site NAMES the
 * same constant.
 *
 * @covers STATUSLINE-04
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Relative and not `@/`: that alias is declared in `client/tsconfig.app.json`
// and `bun test` runs from the repo root, where it resolves nothing.
import { IDENTITY_GLYPH_BOX, IDENTITY_GLYPH_INK } from '../../lib/selectionStyles';

const source = readFileSync(join(import.meta.dir, 'IdentityBlock.tsx'), 'utf8');

/**
 * The source with the prose taken out.
 *
 * The comments in this file NAME what they removed, so a check run over the raw
 * text would find the very string the fix deleted, sitting inside the sentence
 * explaining the deletion. What is checked is the code.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the foot of the column: one glyph box', () => {
  it('the box is the size the faces already use, so the band lines up with what it contains', () => {
    expect(IDENTITY_GLYPH_BOX).toBe('h-3.5 w-3.5');
    expect(IDENTITY_GLYPH_INK).toBe(10);
  });

  it('no site writes its own size: the box is named, never spelled out', () => {
    // The literals that used to be there: `h-4` was the avatar, `size={10}` the
    // bare machine mark, `h-3.5 w-3.5` the org logo writing by hand what the
    // constant now says.
    expect(code).not.toContain('h-4 w-4');
    expect(code).not.toContain('size={10}');
    expect(code).not.toContain("'h-3.5 w-3.5");
  });

  // Two rendering sites, and both marked: the face on a person's chip and the
  // face on the card. The marker is what the pixel test then measures, so a
  // site arriving WITHOUT it would go unmeasured and silent.
  it('every glyph box at the foot of the column is marked', () => {
    // The interpolations, not the import line above them.
    const marked = code.match(/\$\{IDENTITY_GLYPH_BOX\}/g) ?? [];
    expect(marked).toHaveLength(2);
  });

  // The card used to carry a negative margin no other subject had: that is the
  // four pixels the band was out by, and nothing here may reopen it.
  it('nothing cancels the shared inset with a negative margin', () => {
    expect(code).not.toContain('-mx-1');
  });
});
