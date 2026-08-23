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
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sorgente = readFileSync(join(import.meta.dir, 'KanbanBoardPane.tsx'), 'utf8');

/** The source without prose: the comments NAME the literals the fix removed. */
const codice = sorgente
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the project chips: one width, one icon box', () => {
  it('no chip spells its own max width: the two caps were 11rem and 13rem', () => {
    expect(codice).not.toContain('max-w-[11rem]');
    expect(codice).not.toContain('max-w-[13rem]');
    expect(codice).toContain('CHIP_MAX');
  });

  it('the width is named once and both chips reach for that name', () => {
    const dichiarazioni = codice.match(/const CHIP_MAX\b/g) ?? [];
    expect(dichiarazioni).toHaveLength(1);
    // The chip that opens the menu, and the suggestions next to it.
    const usi = codice.match(/\$\{CHIP_MAX\}/g) ?? [];
    expect(usi.length).toBeGreaterThanOrEqual(2);
  });

  it('the icon slot is reserved for everyone, favicon or not', () => {
    // `ProjectFavicon` draws its fallback bare, with no reserved width - it is
    // declared in the component. So the box has to live OUTSIDE it, which is
    // what `ChipIcon` is: a project with no icon on disk must not shift the
    // name next to it.
    expect(codice).toContain('function ChipIcon');
    expect(codice).toContain('const CHIP_ICON_BOX = 12');
    // And no PROJECT chip draws a naked favicon, or a bare dot where an icon
    // should be reserved. The scope is the project chips only: the priority
    // chip next to them draws the same small circle, but there it is the
    // subject itself and not the stand-in for a missing icon - checking the
    // whole file would have called that a fault too.
    const inizio = codice.indexOf('{showProjects && (');
    const fine = codice.indexOf('{/* Priority');
    expect(inizio, 'project chips block not found').toBeGreaterThan(-1);
    const chipProgetti = fine > inizio ? codice.slice(inizio, fine) : codice.slice(inizio);
    expect(chipProgetti).not.toContain('<ProjectFavicon');
    expect(chipProgetti).not.toContain('border border-app-text-faint');
    // They go through the shared slot instead.
    expect(chipProgetti).toContain('<ChipIcon');
  });
});
