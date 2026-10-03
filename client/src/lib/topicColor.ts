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
 * light is the one documented exception, see the palette). A
 * colour from outside the palette (the settings modal's free picker) is painted
 * as it is in both themes, with the ring the dot always has.
 */

export interface TopicColorInks {
  /** The stored value, normalised: what tests and the menu compare against. */
  value: string;
  light: string;
  dark: string;
}

/** Defaults written by the code, never by a person. */
const DEFAULT_TOPIC_COLORS: ReadonlySet<string> = new Set(['#5865f2', '#6366f1', '#0066ff']);

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

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
  // The one exception to 3:1: a yellow dark enough for it (yellow-700) reads
  // as brown, not as the swatch the person picked. yellow-600 stays golden at
  // 2.5:1 on the light chrome, and the dot's ring draws its edge.
  '#eab308': { light: '#ca8a04', dark: '#facc15' },
};

/** The swatches the context menu offers, in display order. */
export const TOPIC_COLOR_OPTIONS: readonly string[] = Object.keys(PALETTE);

/** The inks of a chosen colour, or null when there is no choice to show. */
export function topicColorInks(color: string | null | undefined): TopicColorInks | null {
  if (typeof color !== 'string') return null;
  const value = color.trim().toLowerCase();
  if (!HEX_RE.test(value) || DEFAULT_TOPIC_COLORS.has(value)) return null;
  const inks = PALETTE[value];
  return inks ? { value, ...inks } : { value, light: value, dark: value };
}
