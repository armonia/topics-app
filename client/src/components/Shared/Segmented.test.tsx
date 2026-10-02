/**
 * THE SEGMENTED CONTROL: a radiogroup that says which one is on.
 *
 * It replaces a row whose label named the NEXT state (the view order) and two
 * rows of look-alike buttons (theme, density). The contract a person relies on:
 * one option is checked and announced as such, left and right arrows move and
 * apply, and the sliding indicator rides on the shared motion tokens.
 *
 * Mounted with `renderToStaticMarkup` (no DOM library in this project); the
 * keyboard is the pure `segmentTarget`.
 *
 * @covers USERMENU-07
 * @covers USERMENU-08
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Segmented } from './Segmented';
import { segmentTarget } from './controlKeys';

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const;

describe('Segmented', () => {
  test('a radiogroup with one checked radio, the only tab stop', () => {
    const html = renderToStaticMarkup(
      <Segmented value="dark" options={OPTIONS} onChange={() => {}} ariaLabel="Theme" testId="seg" />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Theme"');
    expect(html.match(/role="radio"/g)?.length).toBe(3);
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"|tabindex="0"[^>]*aria-checked="true"/);
    expect(html.match(/tabindex="-1"/g)?.length).toBe(2);
    expect(html).toContain('data-testid="seg-dark"');
  });

  test('left and right move and wrap; up and down are left to the menu', () => {
    expect(segmentTarget('ArrowRight', 0, 3)).toBe(1);
    expect(segmentTarget('ArrowRight', 2, 3)).toBe(0);
    expect(segmentTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(segmentTarget('ArrowLeft', 1, 3)).toBe(0);
    expect(segmentTarget('ArrowDown', 1, 3)).toBeNull();
    expect(segmentTarget('ArrowUp', 1, 3)).toBeNull();
    expect(segmentTarget('a', 1, 3)).toBeNull();
  });

  test('the indicator slides on the shared tokens, no duration written by hand', () => {
    const source = readFileSync(join(import.meta.dir, 'Segmented.tsx'), 'utf8');
    expect(source).toContain('control-slide');
    expect(source).not.toMatch(/\d+ms|duration-\d|cubic-bezier/);
  });
});
