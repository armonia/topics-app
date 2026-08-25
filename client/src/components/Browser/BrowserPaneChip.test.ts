/**
 * @covers BROWSER-CHROME-01
 */
import { describe, it, expect } from 'bun:test';
import { TONE, type ChipTone } from './browserPaneChipTones';
import { DANGER_TEXT, WARNING_TEXT, SUCCESS_TEXT, ACTIVE_TEXT } from '../../lib/popoverStyles';

/**
 * The chip's tones are a colour DECISION with numbers behind it, so this guards
 * the decision rather than the rendering (there is no DOM in these tests — the
 * house pattern is a pure module plus thin wiring).
 *
 * What was wrong: the pane's four floating badges each carried their own
 * hand-written palette, and the status pill used raw `green-600` / `yellow-600`.
 * Measured over their OWN `/15` tint in the light theme those are 2,81:1 and
 * 2,65:1, against the 4,5 threshold that applies to 11px text. The tint is the
 * part that catches people out: a 15% veil of the same hue moves the ground
 * toward the ink, so `green-700` — the obvious fix — still misses at 4,32, and
 * only `green-800` (6,20) clears it.
 */
const ALL_TONES: ChipTone[] = ['neutral', 'active', 'ok', 'warn', 'danger'];

describe('BrowserPaneChip tones', () => {
  it('the status tones use the measured tokens, not a raw palette shade', () => {
    expect(TONE.ok).toContain(SUCCESS_TEXT);
    expect(TONE.warn).toContain(WARNING_TEXT);
    expect(TONE.danger).toContain(DANGER_TEXT);
    expect(TONE.active).toContain(ACTIVE_TEXT);
  });

  it('no tone re-introduces a shade that failed the light theme', () => {
    // green-600 → 2,81:1 · yellow-600 → 2,65:1 · green-700 → 4,32:1, all under 4,5.
    for (const tone of ALL_TONES) {
      for (const bad of ['text-green-600', 'text-yellow-600', 'text-green-700', 'text-red-600']) {
        expect(TONE[tone]).not.toContain(bad);
      }
    }
  });

  it('active does not fall back to the raw, unmeasured text-primary in light theme', () => {
    // text-primary (#0066ff) over the chip's own bg-primary/15 veil measures
    // 3,90:1 in light theme, under the 4,5 threshold — it must appear only
    // after a `dark:` prefix, where the theme's own override (index.css
    // `.dark .text-primary`) already clears the bar.
    expect(TONE.active).not.toMatch(/(?<!dark:)\btext-primary\b/);
  });

  it('the success token is the one that clears the threshold over its tint', () => {
    expect(SUCCESS_TEXT).toBe('text-green-800 dark:text-green-400');
  });

  it('warning and danger reuse the pairs the app already measured', () => {
    expect(WARNING_TEXT).toBe('text-amber-800 dark:text-amber-400');
    expect(DANGER_TEXT).toBe('text-red-700 dark:text-red-400');
  });

  it('active is the shade that clears the threshold over the primary tint', () => {
    // blue-800 measures 7,12:1 over bg-primary/15 in light theme (blue-700
    // already clears at 5,51 but blue-800 matches the /800 step its siblings
    // landed on). Dark keeps text-primary: index.css already retints it via
    // `.dark .text-primary`, which measures 5,68 on these chips.
    expect(ACTIVE_TEXT).toBe('text-blue-800 dark:text-primary');
  });

  it('every colour token names a shade for BOTH themes', () => {
    // A token defined for one theme only is how the co-browse chip ended up as a
    // black pill sitting on a light background.
    for (const token of [SUCCESS_TEXT, WARNING_TEXT, DANGER_TEXT, ACTIVE_TEXT]) {
      expect(token).toMatch(/^text-\S+ dark:text-\S+$/);
    }
  });

  it('no tone hardcodes black or white text', () => {
    for (const tone of ALL_TONES) {
      expect(TONE[tone]).not.toContain('text-white');
      expect(TONE[tone]).not.toContain('text-black');
    }
  });

  it('every tone carries a background AND a text colour', () => {
    // A tone that sets only one of the two inherits the other from whatever page
    // is underneath — which for a badge floating over arbitrary web content is
    // not a colour anyone chose.
    for (const tone of ALL_TONES) {
      expect(TONE[tone]).toMatch(/\bbg-/);
      expect(TONE[tone]).toMatch(/\btext-/);
    }
  });
});
