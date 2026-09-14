/**
 * ONE EDGE, TWO RENDERINGS.
 *
 * The window's left edge (pixels, in JS) and the chat's right padding (a CSS
 * expression, because the chat sizes itself) have to land on the same column.
 * On a 1024 px window that was true by luck: the expanded width fitted. On a
 * 900 px one the two formulas disagreed by 96 px and the window sat on top of
 * the composer, which is the bug this file exists to keep out.
 */
import { describe, test, expect } from 'bun:test';
import { expandedInsetFor, expandedInsetCss, MIN_CHAT_WIDTH, DEFAULT_EXPANDED_WIDTH } from './topicBrowserWindowLazy';

/** What the browser would compute for the CSS expression, given a real width. */
function evaluateCss(css: string, areaWidth: number): number {
  const match = css.match(/min\((\d+(?:\.\d+)?)px, calc\(100% - (\d+)px\)\)/);
  if (!match) throw new Error(`unexpected expression: ${css}`);
  return Math.max(0, Math.min(Number(match[1]), areaWidth - Number(match[2])));
}

describe('the space the chat cedes when the window is expanded', () => {
  test('a wide area gives the window exactly what it asked for', () => {
    expect(expandedInsetFor(1440, DEFAULT_EXPANDED_WIDTH)).toBe(DEFAULT_EXPANDED_WIDTH);
  });

  test('a narrow area cuts the window, never the chat below its minimum', () => {
    // 644 px of area: this is the case that used to cover the composer.
    expect(expandedInsetFor(644, 480)).toBe(644 - MIN_CHAT_WIDTH);
    expect(644 - expandedInsetFor(644, 480)).toBe(MIN_CHAT_WIDTH);
  });

  test('an area narrower than the chat minimum cedes nothing at all', () => {
    expect(expandedInsetFor(240, 480)).toBe(0);
  });

  test('the CSS the chat uses agrees with the pixels the window uses', () => {
    for (const areaWidth of [320, 500, 644, 740, 900, 1024, 1440]) {
      for (const requested of [360, 420, 480, 900]) {
        expect(evaluateCss(expandedInsetCss(requested), areaWidth))
          .toBe(expandedInsetFor(areaWidth, requested));
      }
    }
  });
});
