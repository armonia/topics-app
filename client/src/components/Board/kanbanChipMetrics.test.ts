/**
 * THE PROJECT CHIPS IN THE BOARD TOPBAR ARE ONE ROW, and that is a measurement.
 *
 * They were two of everything. The chip that opens the project menu was capped
 * at `11rem`, the suggestion chips beside it at `13rem`: the same project name,
 * on the same line, truncated at two different points. And the icon slot: a
 * project with a favicon on disk got 12px, one without got a bare 6px dot, so
 * the names behind them started at two different offsets. Neither chip is wrong
 * on its own, which is exactly why the fault reads as "the row looks crooked"
 * instead of as a bug with an address.
 *
 * These checks read the SOURCE and not a render, on purpose: the fault was
 * literals written in two places, and a render test goes green again the moment
 * someone types a third one somewhere else. What is pinned is that the row
 * NAMES its measurements instead of spelling them.
 *
 * THE ADDRESS MOVED, THE CLAIM DID NOT. The chips used to be built inline in
 * `KanbanBoardPane.tsx` and this file read that source. The topbar rework put
 * the chip, its menu and its suggestions into one component, so the row now
 * names its measurements in `ProjectFilterPicker.tsx` — one declaration each,
 * reached by both chips. Reading the old file would have made this go red on a
 * change that KEEPS the rule; reading the new one keeps asking the question the
 * fault asked. The topbar is checked too, so the literals cannot come back
 * there.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The source without prose: the comments NAME the literals the fix removed. */
const senzaProsa = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const leggi = (f: string) => senzaProsa(readFileSync(join(import.meta.dir, f), 'utf8'));

const codice = leggi('ProjectFilterPicker.tsx');
const topbar = leggi('KanbanBoardPane.tsx');

describe('the project chips: one width, one icon box', () => {
  it('no chip spells its own max width: the two caps were 11rem and 13rem', () => {
    for (const src of [codice, topbar]) {
      expect(src).not.toContain('max-w-[11rem]');
      expect(src).not.toContain('max-w-[13rem]');
    }
    expect(codice).toContain('CHIP_MAX');
  });

  it('the width is named once and both chips reach for that name', () => {
    const dichiarazioni = codice.match(/const CHIP_MAX\b/g) ?? [];
    expect(dichiarazioni).toHaveLength(1);
    // The chip that opens the menu, and the suggestions next to it.
    const usi = codice.match(/\$\{CHIP_MAX\}/g) ?? [];
    expect(usi.length).toBeGreaterThanOrEqual(2);
    // And the name is not re-declared where the chips used to live.
    expect(topbar).not.toContain('const CHIP_MAX');
  });

  it('the icon slot is reserved for everyone, favicon or not', () => {
    // `ProjectFavicon` draws its fallback bare, with no reserved width - it is
    // declared in the component. So the box has to live OUTSIDE it, which is
    // what `ChipIcon` is: a project with no icon on disk must not shift the
    // name next to it.
    expect(codice).toContain('function ChipIcon');
    expect(codice).toContain('const ICON_BOX = 12');
    // And no chip draws a naked favicon, or a bare dot where an icon should be
    // reserved: everything goes through the shared slot. Measured with
    // `ChipIcon` itself cut out, because inside it BOTH are correct - the
    // favicon sized to the box, and the dot as the box's own fallback.
    const inizio = codice.indexOf('function ChipIcon');
    const fine = codice.indexOf('export function ProjectFilterPicker');
    expect(inizio, 'ChipIcon not found').toBeGreaterThan(-1);
    expect(fine, 'ProjectFilterPicker not found').toBeGreaterThan(inizio);
    const fuoriDallaScatola = codice.slice(0, inizio) + codice.slice(fine);
    expect(fuoriDallaScatola).not.toContain('<ProjectFavicon');
    expect(fuoriDallaScatola).not.toContain('border border-app-text-faint');
    expect(codice).toContain('<ChipIcon');
    // The topbar hands the row over whole: it must not draw a project chip of
    // its own any more, or the two would drift apart exactly as before.
    expect(topbar).not.toContain('<ProjectFavicon');
    expect(topbar).toContain('<ProjectFilterPicker');
  });
});
