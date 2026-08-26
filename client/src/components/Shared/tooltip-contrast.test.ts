/**
 * A tooltip has to be READABLE, and this test exists because it was not.
 *
 * Measured inside Topics installed on Windows 11 on 2026-08-26: the tooltip
 * opened, was opaque, sat inside the window, with `opacity: 1` — and what you saw
 * was an empty black rectangle. The text was `rgb(26,27,28)` over `rgb(30,30,30)`:
 * a contrast ratio of 1.03 out of 21. The report said "the tooltips can't be
 * seen", and it was exactly right.
 *
 * The cause: `bg-app-panel`, i.e. `--bg-panel`, is `#1e1e1e` in the LIGHT theme
 * too (it is the background of code blocks, deliberately dark — its own
 * declaration in `index.css` says so). On top of it sat `text-app-text`, which in
 * the light theme is nearly black.
 *
 * WHY A TEST ON CLASSES AND NOT ON PIXELS. The real ratio is measured by
 * rendering the app in a browser with the CSS loaded, which this suite does not
 * do. But the pair "dark-theme background + light-theme text" is a WRONG
 * combination in itself, however it ends up being painted: it is checkable here,
 * it costs nothing, and it would have stopped this defect before it reached a
 * machine.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(import.meta.dir, '..', '..');

/**
 * The tokens that are DARK IN BOTH THEMES, i.e. that do not follow the theme.
 * Legitimate where the text above them is light by construction (a code fence);
 * a defect under `text-app-text`, which does follow the theme.
 */
const ALWAYS_DARK_BACKGROUNDS = ['bg-app-panel', 'bg-app-code'];

const TEXT_SURFACES = [
  'components/Shared/Tooltip.tsx',
  'components/Shared/TooltipDelegate.tsx',
];

describe('text surfaces do not use a background that ignores the theme', () => {
  for (const rel of TEXT_SURFACES) {
    it(`${rel} does not put text-app-text on an always-dark background`, () => {
      const src = readFileSync(join(SRC, rel), 'utf8');
      // Only className lines: the comments NAME those tokens on purpose, to
      // explain why they are not used — and a test that trips over its own
      // explanation is a test that forces people not to explain.
      const lines = src
        .split('\n')
        .filter((l) => l.includes('className=') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

      for (const line of lines) {
        for (const bg of ALWAYS_DARK_BACKGROUNDS) {
          const hasDarkBg = new RegExp(`(^|[\\s"'\`])${bg}([\\s"'\`]|$)`).test(line);
          if (hasDarkBg && line.includes('text-app-text')) {
            throw new Error(
              `${rel}: "${bg}" is dark in the light theme too, and "text-app-text" is nearly black there: ` +
                `together they give black text on a black background. Use "bg-elevated", which follows the theme.\n  ${line.trim()}`,
            );
          }
        }
      }
    });
  }

  it('both tooltips use THE SAME background', () => {
    // Two tooltips with two different backgrounds read as two different
    // components, and it is also how one of them stays behind when the other is
    // fixed — which is precisely how this defect came about.
    const backgrounds = TEXT_SURFACES.map((rel) => {
      const src = readFileSync(join(SRC, rel), 'utf8');
      const m = src.match(/className="pointer-events-none fixed[^"]*?\b(bg-[\w-]+)\b/);
      return m?.[1] ?? null;
    });
    expect(backgrounds[0]).not.toBeNull();
    expect(backgrounds[0]).toBe(backgrounds[1]);
  });
});
