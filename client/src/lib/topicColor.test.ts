/**
 * The colour a person chose for a topic, and the two inks it is painted with.
 *
 * @covers TOPIC-02
 */
import { describe, expect, it } from 'bun:test';
import { TOPIC_COLOR_OPTIONS, topicColorInks } from './topicColor';

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('topicColorInks', () => {
  it('the defaults the code writes on every new topic are not a choice', () => {
    for (const c of ['#5865f2', '#6366f1', '#0066ff', '#0066FF', ' #5865f2 ']) {
      expect(topicColorInks(c), c).toBeNull();
    }
  });

  it('no colour, an empty one, or a malformed one shows nothing', () => {
    for (const c of [undefined, null, '', 'blue', '#12', '#1234567', 'rgb(0,0,0)']) {
      expect(topicColorInks(c as string | null | undefined), String(c)).toBeNull();
    }
  });

  it('a palette colour maps to its light and dark ink', () => {
    expect(topicColorInks('#4338ca')).toEqual({ value: '#4338ca', light: '#4338ca', dark: '#818cf8' });
    expect(topicColorInks('#EAB308')).toEqual({ value: '#eab308', light: '#ca8a04', dark: '#facc15' });
  });

  it('a colour from outside the palette is painted as it is in both themes', () => {
    expect(topicColorInks('#123abc')).toEqual({ value: '#123abc', light: '#123abc', dark: '#123abc' });
  });

  it('every palette ink clears 3:1 against the chrome and the surface of its theme (yellow on light: 2.4)', () => {
    // --chrome-bg and --bg-surface of each theme (index.css), as hex.
    const light = ['#ecedee', '#ffffff'];
    const dark = ['#080a0e', '#1b1c1d'];
    for (const option of TOPIC_COLOR_OPTIONS) {
      const inks = topicColorInks(option)!;
      // Yellow on light is the documented exception (a 3:1 yellow is brown).
      const lightFloor = option === '#eab308' ? 2.4 : 3;
      for (const bg of light) expect(contrast(inks.light, bg), `${option} light on ${bg}`).toBeGreaterThanOrEqual(lightFloor);
      for (const bg of dark) expect(contrast(inks.dark, bg), `${option} dark on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});
