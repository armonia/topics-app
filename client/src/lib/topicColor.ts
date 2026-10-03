/**
 * The colour a person CHOSE for a topic, and how it is painted.
 *
 * `topic.color` is never empty: the server and the client write a default on
 * every new topic (`#5865f2` in the routes, `#6366f1` in the DB, `#0066ff` for a
 * chat created from the UI). Those are not a choice, they are the invented
 * colours the sidebar must not paint («no invented colours»), so they read as
 * NO colour here. Anything else was picked (the context menu, the settings
 * modal, a template) and is shown as a small dot.
 *
 * The palette offered by the context menu is tuned for the light chrome; on the
 * dark chrome its 600/700 shades sink into the background (indigo-700 on
 * #080a0e is about 2:1). Each palette entry therefore carries a light and a dark
 * ink, clearing 3:1 against their chrome (the non-text contrast bar; yellow on
 * light is the one ink below it, 2.5:1, see the palette). An ink that does not
 * clear 3:1 on its own gets a RING that does (`ringLight` / `ringDark`): the
 * dot's edge is then what meets the bar, computed below, not judged by eye. A
 * colour from outside the palette (the settings modal's free picker) is painted
 * as it is in both themes, and gets a ring by the same rule.
 */

import { contrastRatio, fromHex, toHex, type RGB } from './iconTint';

export interface TopicColorInks {
  /** The stored value, normalised: what tests and the menu compare against. */
  value: string;
  light: string;
  dark: string;
  /** The edge of the dot on the light chrome, when `light` alone stays under
   *  3:1 against it; null when the ink clears the bar by itself. */
  ringLight: string | null;
  /** The same for the dark chrome and `dark`. */
  ringDark: string | null;
}

/** Defaults written by the code, never by a person. */
const DEFAULT_TOPIC_COLORS: ReadonlySet<string> = new Set(['#5865f2', '#6366f1', '#0066ff']);

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** The non-text contrast bar (WCAG 1.4.11) the dot's edge has to reach. */
export const TOPIC_DOT_MIN_CONTRAST = 3;

/**
 * The grounds the dot sits on in each theme: `--chrome-bg` (the sidebar and the
 * tab bar) and `--bg-surface` (index.css), as hex. A ring has to clear the bar
 * against every one of them, since the same dot is drawn on both.
 */
export const TOPIC_DOT_GROUNDS = {
  light: ['#ecedee', '#ffffff'],
  dark: ['#080a0e', '#1b1c1d'],
} as const;

/** The context menu's palette: stored value → light / dark ink. */
const PALETTE: Readonly<Record<string, { light: string; dark: string }>> = {
  '#0066cc': { light: '#0066cc', dark: '#60a5fa' },
  '#059669': { light: '#047857', dark: '#34d399' },
  '#dc2626': { light: '#dc2626', dark: '#f87171' },
  '#7c3aed': { light: '#7c3aed', dark: '#a78bfa' },
  '#ea580c': { light: '#c2410c', dark: '#fb923c' },
  '#0891b2': { light: '#0e7490', dark: '#22d3ee' },
  '#be185d': { light: '#be185d', dark: '#f472b6' },
  '#4338ca': { light: '#4338ca', dark: '#818cf8' },
  '#16a34a': { light: '#15803d', dark: '#4ade80' },
  // The one ink under 3:1: a yellow dark enough for it (yellow-700) reads as
  // brown, not as the swatch the person picked. yellow-600 stays golden at
  // 2.5:1 on the light chrome (2.9:1 on white), and the computed ring
  // (`ringLight`) gives the dot an edge that reaches 3:1.
  '#eab308': { light: '#ca8a04', dark: '#facc15' },
};

/** The swatches the context menu offers, in display order. */
export const TOPIC_COLOR_OPTIONS: readonly string[] = Object.keys(PALETTE);

function lowestContrast(ink: RGB, grounds: readonly string[]): number {
  return Math.min(...grounds.map((g) => contrastRatio(ink, fromHex(g)!)));
}

/**
 * The ring that gives `ink` an edge of at least 3:1 against every ground of a
 * theme, or null when the ink already clears it. The ring is the ink itself,
 * mixed toward black on a light theme and toward white on a dark one, in 5%
 * steps until it clears: the same hue, so the dot still reads as the colour the
 * person picked, only outlined.
 */
export function topicDotRing(ink: string, theme: 'light' | 'dark'): string | null {
  const rgb = fromHex(ink);
  if (!rgb) return null;
  const grounds = TOPIC_DOT_GROUNDS[theme];
  if (lowestContrast(rgb, grounds) >= TOPIC_DOT_MIN_CONTRAST) return null;
  const toward = theme === 'light' ? 0 : 255;
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const mixed = {
      r: rgb.r + (toward - rgb.r) * t,
      g: rgb.g + (toward - rgb.g) * t,
      b: rgb.b + (toward - rgb.b) * t,
    };
    const hex = toHex(mixed);
    if (lowestContrast(fromHex(hex)!, grounds) >= TOPIC_DOT_MIN_CONTRAST) return hex;
  }
  return theme === 'light' ? '#000000' : '#ffffff';
}

/** The inks of a chosen colour, or null when there is no choice to show. */
export function topicColorInks(color: string | null | undefined): TopicColorInks | null {
  if (typeof color !== 'string') return null;
  const value = color.trim().toLowerCase();
  if (!HEX_RE.test(value) || DEFAULT_TOPIC_COLORS.has(value)) return null;
  const inks = PALETTE[value] ?? { light: value, dark: value };
  return { value, ...inks, ringLight: topicDotRing(inks.light, 'light'), ringDark: topicDotRing(inks.dark, 'dark') };
}

/**
 * The ink of a chosen colour for the theme on screen, or undefined when there
 * is no choice. For surfaces painted outside React's class names (the drag
 * preview builds its own node), which cannot use the `dark:` variant.
 */
export function topicColorInk(color: string | null | undefined, dark: boolean): string | undefined {
  const inks = topicColorInks(color);
  if (!inks) return undefined;
  return dark ? inks.dark : inks.light;
}

/**
 * What to store when a person picks `picked` in a free colour picker.
 *
 * A pick that happens to equal one of the code's defaults would read back as
 * NO colour (see `DEFAULT_TOPIC_COLORS`), so the choice would silently vanish.
 * It is stored one step off in the blue channel instead: the same colour to the
 * eye, and a value no code path writes by itself, so it reads as chosen.
 */
export function storableTopicColor(picked: string): string {
  const value = picked.trim().toLowerCase();
  if (!DEFAULT_TOPIC_COLORS.has(value)) return value;
  const rgb = fromHex(value)!;
  return toHex({ ...rgb, b: rgb.b > 0 ? rgb.b - 1 : 1 });
}
