/**
 * The terminal and the chat code blocks share one monospace stack, JetBrains
 * Mono, vendored with `font-display: swap`. The padding is 12 px on every side
 * and the line height is 1.25.
 *
 * The browser geometry (the 12 px gap under the last row, the cover lining up
 * with xterm) is measured in the e2e suite; these tests pin the values and the
 * font declaration that the geometry depends on.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MONO_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_PADDING_PX,
} from './terminalTypography';

const CLIENT_ROOT = join(import.meta.dir, '..', '..', '..');
const css = readFileSync(join(CLIENT_ROOT, 'src', 'index.css'), 'utf8');

describe('terminal typography', () => {
  test('the mono stack leads with JetBrains Mono', () => {
    expect(MONO_FONT_FAMILY.startsWith("'JetBrains Mono'")).toBe(true);
  });

  test('line height is 1.25 and the padding is 12 px', () => {
    expect(TERMINAL_LINE_HEIGHT).toBe(1.25);
    expect(TERMINAL_PADDING_PX).toBe(12);
    expect(TERMINAL_FONT_SIZE).toBe(13);
  });

  test('both JetBrains Mono weights are vendored under public/fonts', () => {
    for (const file of ['JetBrainsMono-Regular.woff2', 'JetBrainsMono-Bold.woff2']) {
      expect(existsSync(join(CLIENT_ROOT, 'public', 'fonts', file))).toBe(true);
      expect(css).toContain(`url('/fonts/${file}')`);
    }
  });

  test('the @font-face declarations use font-display: swap', () => {
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const jetbrains = faces.filter((f) => f.includes("'JetBrains Mono'"));
    expect(jetbrains).toHaveLength(2);
    for (const face of jetbrains) expect(face).toContain('font-display: swap');
  });

  test('chat code blocks and inline code use the shared stack', () => {
    expect(css).toContain('--font-mono: \'JetBrains Mono\'');
    expect(css).toContain('font-family: var(--font-mono);');
  });
});
