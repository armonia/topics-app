/**
 * THE SHELL MUST EXIST IN BOTH THEMES.
 *
 * The shell is the only thing that tells whoever looks at the filter row that
 * the projects lined up there ARE the selector leaned out onto the row and not
 * chips that happened to land next to it. Born `border-white/15
 * bg-white/[0.05]`, it was white on white in the light theme: it was in the
 * DOM, it measured, and it could not be seen. Sent back three times with the
 * same sentence, «they are still not wrapped by the selector», while the code
 * looked fine every time it was read again.
 *
 * The RULE at the top of `client/src/index.css` already says it in words: a
 * raised surface is declared `bg-black/N dark:bg-white/N`, or with the opaque
 * tokens. That rule, though, lives in a comment, and a comment stops nothing.
 * This is the piece that enforces it on the very point where it has already
 * broken.
 *
 * A check on the SOURCE, with the same method and the same reason as
 * `Card.test.ts`: `ProjectFilterPicker.tsx` imports by the `@/` alias, which
 * `bun test` does not resolve, so the component does not mount here.
 *
 * @covers KANBAN-12
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ProjectFilterPicker.tsx'),
  'utf8',
);

/** The shell's line: the one with its testid, which is its proper name. */
const shellLine = src
  .split('\n')
  .find((l) => l.includes('rounded-md border') && l.includes('bg-'))
  ?? '';

describe('il fondino del selettore progetto', () => {
  test("esiste, ed e' l'elemento che porta il testid", () => {
    expect(src).toContain('data-testid="project-filter-shell"');
    expect(shellLine).not.toBe('');
  });

  test("non e' bianco su bianco: ogni rialzo dichiara il tema chiaro", () => {
    // `bg-white/N` BARE (without the `bg-black/N` half that covers the light
    // theme) is exactly the defect that made the shell disappear.
    const bareWhiteFill = /(?<!dark:)bg-white\//.test(shellLine);
    expect(bareWhiteFill).toBe(false);
    expect(shellLine).toContain('dark:bg-white/');
    expect(shellLine).toContain('bg-black/');
  });

  test("il bordo usa il token che i due temi risolvono da se'", () => {
    // The `-light` variant, not the base border: in light the base is worth
    // 91.4% of lightness on a background of 93 and disappears again, in dark it
    // is weaker than the white/15 it replaces. See the comment in the component.
    expect(shellLine).toContain('border-app-border-light');
    expect(shellLine.includes('border-white/')).toBe(false);
  });

  test('sta dietro: non ruba i click e non entra in nessuna misura', () => {
    // If the shell intercepted the events, it would cover the chip it wraps;
    // if it entered the flow, it would falsify the measurement of how many
    // chips fit.
    expect(shellLine).toContain('pointer-events-none');
    expect(shellLine).toContain('absolute');
  });

  test('non passa rasente ai chip: ha respiro anche in verticale', () => {
    // `inset-y-0` made the shell EXACTLY as tall as the chips (the host has no
    // vertical padding: the bar is 36px tall and an e2e verifies it).
    // A box that touches its own content reads as a wrong alignment, not as a
    // grouping. It leans out of the flow, inside the bar's `py-1.5`: not one
    // pixel more of height.
    expect(shellLine).toContain('-inset-y-');
    expect(shellLine.includes('inset-y-0')).toBe(false);
  });
});

/**
 * THE SIZES INSIDE THE BOX.
 *
 * Reported once the shell could be seen: «they ought to be well spaced, maybe
 * something smaller or larger, and everything consistent in terms of sizes».
 * They were three different measures for the same object, and not one of them
 * shows up on its own: what shows up is the result, that is, a row that is not
 * lined up.
 */
describe('i chip del selettore hanno una misura sola', () => {
  test('una sola larghezza massima, non due', () => {
    // They were `max-w-[11rem]` on the chip that opens the menu and
    // `max-w-[13rem]` on the suggestions: the same name truncated at two
    // measures in the same row.
    const widths = new Set(src.match(/max-w-\[[^\]]+\]/g) ?? []);
    expect(widths.size).toBe(1);
  });

  test("la scatola dell'icona e' una sola, e la riserva sempre", () => {
    // `ProjectFavicon` draws the fallback BARE, with no reserved width: with
    // the 6px dot in place of the 12px icon, the chips without an icon were
    // indented by half. The box sits outside the favicon.
    expect(src).toContain('const ICON_BOX = 12');
    expect(src).toContain('function ChipIcon');
    // No chip draws the favicon (or its fallback) on its own any more.
    expect(src.includes('<ProjectFavicon path={p.path}')).toBe(false);
    expect(src.includes('<ProjectFavicon path={soleProject.path}')).toBe(false);
  });
});
