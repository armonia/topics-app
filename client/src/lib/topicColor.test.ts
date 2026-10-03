/**
 * The colour a person chose for a topic, and the two inks it is painted with.
 *
 * @covers TOPIC-02
 */
import { describe, expect, it } from 'bun:test';
import {
  TOPIC_COLOR_OPTIONS,
  storableTopicColor,
  topicColorInk,
  topicColorInks,
} from './topicColor';

/** WCAG relative luminance of a #rrggbb colour. Written here again, not
 *  imported, so the bar is measured by a second hand. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// --chrome-bg and --bg-surface of each theme (index.css), as hex.
const LIGHT = ['#ecedee', '#ffffff'];
const DARK = ['#080a0e', '#1b1c1d'];

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
    expect(topicColorInks('#4338ca')).toMatchObject({ value: '#4338ca', light: '#4338ca', dark: '#818cf8' });
    expect(topicColorInks('#EAB308')).toMatchObject({ value: '#eab308', light: '#ca8a04', dark: '#facc15' });
  });

  it('a colour from outside the palette is painted as it is in both themes', () => {
    expect(topicColorInks('#123abc')).toMatchObject({ value: '#123abc', light: '#123abc', dark: '#123abc' });
  });

  it('every palette ink clears 3:1 against the chrome and the surface of its theme (yellow on light: 2.5)', () => {
    for (const option of TOPIC_COLOR_OPTIONS) {
      const inks = topicColorInks(option)!;
      // Yellow on light is the one ink under the bar (a 3:1 yellow is brown):
      // 2.5:1 on the chrome, the same figure the palette's comment gives.
      const lightFloor = option === '#eab308' ? 2.5 : 3;
      for (const bg of LIGHT) expect(contrast(inks.light, bg), `${option} light on ${bg}`).toBeGreaterThanOrEqual(lightFloor);
      for (const bg of DARK) expect(contrast(inks.dark, bg), `${option} dark on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the edge of the dot reaches 3:1 on every ground, ink or ring', () => {
  /** What the eye meets first: the ring when there is one, else the ink. */
  const edge = (ink: string, ring: string | null) => ring ?? ink;

  it('yellow on light gets a ring that clears 3:1 on the chrome and on white', () => {
    const inks = topicColorInks('#eab308')!;
    expect(inks.ringLight, 'yellow on light needs a ring').not.toBeNull();
    for (const bg of LIGHT) expect(contrast(inks.ringLight!, bg), `ring on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it('every palette colour, and pale or dark free picks, has a 3:1 edge in both themes', () => {
    for (const c of [...TOPIC_COLOR_OPTIONS, '#ffff00', '#fefefe', '#f0e68c', '#101010', '#000000']) {
      const inks = topicColorInks(c)!;
      for (const bg of LIGHT) expect(contrast(edge(inks.light, inks.ringLight), bg), `${c} light edge on ${bg}`).toBeGreaterThanOrEqual(3);
      for (const bg of DARK) expect(contrast(edge(inks.dark, inks.ringDark), bg), `${c} dark edge on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('an ink that clears the bar alone keeps no computed ring', () => {
    const inks = topicColorInks('#4338ca')!;
    expect(inks.ringLight).toBeNull();
    expect(inks.ringDark).toBeNull();
  });
});

describe('topicColorInk: the ink for the theme on screen (drag preview)', () => {
  it('the light ink on light, the dark ink on dark, never the stored value when they differ', () => {
    expect(topicColorInk('#059669', false)).toBe('#047857');
    expect(topicColorInk('#059669', true)).toBe('#34d399');
  });

  it('no choice, no ink', () => {
    expect(topicColorInk('#5865f2', true)).toBeUndefined();
    expect(topicColorInk('', false)).toBeUndefined();
  });
});

describe('storableTopicColor: a free pick always reads back as a choice', () => {
  it('a pick equal to a default is stored as a value that reads as chosen, and looks the same', () => {
    for (const d of ['#5865f2', '#6366f1', '#0066ff', '#0066FF']) {
      const stored = storableTopicColor(d);
      expect(topicColorInks(stored), `${d} → ${stored}`).not.toBeNull();
      // One unit on one channel: the same colour to the eye.
      const diff = [1, 3, 5].reduce((n, i) => n + Math.abs(parseInt(stored.slice(i, i + 2), 16) - parseInt(d.toLowerCase().slice(i, i + 2), 16)), 0);
      expect(diff, `${d} → ${stored}`).toBe(1);
    }
  });

  it('any other pick is stored as it is', () => {
    expect(storableTopicColor('#123ABC')).toBe('#123abc');
    expect(storableTopicColor('#eab308')).toBe('#eab308');
  });
});
