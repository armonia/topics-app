/**
 * THE BAND AT THE BOTTOM OF THE SIDEBAR IS ONE BAND, and that is a measurement.
 *
 * Three subjects sit there — me, my organisations, who is around — and what
 * tells them apart is the FIRST GLYPH of each, not a separator line. That only
 * works if the three glyphs occupy the same box: a face at 16px, an org logo at
 * 14 and a people mark at 10 are three different left edges, and the band reads
 * as a crooked stack instead of one thing.
 *
 * It was crooked. Measured on the delivery screenshot of 2026-08-21 (the one
 * attached to the card as its evidence), the three rows in the bottom band were
 * 16px, 8px and 11px tall, with the left edge jumping between x=6 and x=10.
 *
 * This test reads the SOURCE, not a render, on purpose: the fault was three
 * literals written in three places, and a render test would have gone green
 * again the moment someone typed a fourth. What is pinned here is that the
 * three subjects name the SAME constant.
  *
 * @covers STATUSLINE-01
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Relative and not `@/`: that alias is declared in `client/tsconfig.app.json`
// and `bun test` runs from the repo root, where it resolves nothing. The
// neighbouring test gets away with it because it only imports a TYPE, which is
// erased before anything has to be found on disk.
import { IDENTITY_GLYPH_BOX, IDENTITY_GLYPH_INK } from '../../lib/selectionStyles';

const source = readFileSync(join(import.meta.dir, 'IdentityBlock.tsx'), 'utf8');

/**
 * The source with the prose taken out.
 *
 * The comments in this file NAME what they removed — "`-mx-1` cancelled the
 * chip's own padding" — so a check run over the raw text would find the very
 * string the fix deleted, sitting inside the sentence explaining the deletion.
 * What is checked is the code.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The three subjects, each with the line that opens it in the source. */
const SUBJECTS = [
  ['me', 'identity-row-me'],
  ['organisations', 'identity-row-orgs'],
  ['friends', 'identity-row-friends'],
] as const;

describe('the identity band: one glyph box for the three subjects', () => {
  it('the box is the size the faces already use, so the band lines up with what it contains', () => {
    expect(IDENTITY_GLYPH_BOX).toBe('h-3.5 w-3.5');
    expect(IDENTITY_GLYPH_INK).toBe(10);
  });

  it('no subject writes its own size: the box is named, never spelled out', () => {
    // The literals that used to be there, one per subject. `h-4` was the
    // avatar, `size={10}` the bare machine and people marks, `h-3.5 w-3.5`
    // the org logo writing by hand what the constant now says.
    const start = code.indexOf('function RigaIo');
    const end = code.indexOf('function Facce');
    const band = code.slice(start, end);
    expect(band).not.toContain('h-4 w-4');
    expect(band).not.toContain('size={10}');
  });

  // Every subject in the band opens with the marked box. The marker is what the
  // pixel test then measures, so a subject arriving WITHOUT it would go
  // unmeasured and silent: that, not the total, is what this guards.
  //
  // The total is four because the count is per rendering SITE, not per subject,
  // and the orgs subject has two mutually exclusive ones: the populated chip
  // (through `Logo`) and `EmptyOrgChip`. That second site is the point of the
  // redesign, not an accident. The orgs chip used to VANISH at zero, so the one
  // person who most needed the band to say what an organisation is was the one
  // person it said nothing to. Now zero is a state you can see and click, so it
  // has a glyph like any other, and it is measured like any other.
  it('every glyph box in the band is marked, one per rendering site', () => {
    expect(SUBJECTS).toHaveLength(3);
    // "me" and "friends" are written inline; orgs reaches the mark through
    // `Logo` when populated and writes it directly when empty.
    const marked = code.match(/identity-glyph/g) ?? [];
    expect(marked).toHaveLength(4);
  });

  // The organisation mark reaches the box through its PLACE, not through a
  // number: the prop used to be the size itself (`size={3.5}`), which is how a
  // third measurement got written by hand right next to the other two.
  // The org LOGO (inside each group chip) shares the same box as the band
  // glyphs: it used to spell `h-3.5 w-3.5` by hand, which is how a value that
  // has to move together with the others ended up written in two places.
  it('the org logo names the shared box instead of copying its value', () => {
    const logo = code.slice(code.indexOf('function Logo'));
    expect(logo.slice(0, 400)).toContain('IDENTITY_GLYPH_BOX');
    expect(logo.slice(0, 400)).not.toContain("'h-3.5 w-3.5 text-[7px]'");
  });

  // The "me" chip had a negative margin no other subject carried: that is the
  // four pixels the band was out by, and nothing else in the file may reopen it.
  it('no subject cancels the shared inset with a negative margin', () => {
    // The whole band, not just one subject: two of the three carried it.
    const start = code.indexOf('function RigaIo');
    const end = code.indexOf('function Facce');
    expect(code.slice(start, end)).not.toContain('-mx-1');
  });
});
