/**
 * The figures and tones the boxes of «Consumi» share (hub-smistamento,
 * HUBBR-12): the model tones, the token, percent and time texts, the model's
 * name and a round top for the chart's axis. Plain functions, apart from the
 * components in hubUsageUi so fast refresh keeps working there.
 */
import type { useT } from '../../hooks/useT';
import { friendlyModelLabel } from '../../lib/modelLabel';
import { tokenParts } from '../../lib/hubUsage';

export type Tr = ReturnType<typeof useT>;

/** A quota from here up is drawn amber, as everywhere else in Topics. */
export const HOT_AT = 80;

/** The five model tones of the mockup, light and dark, for the chart, the legend and the bars. */
export const TONES = [
  { fill: 'fill-[#0066ff] dark:fill-[#4d94ff]', bg: 'bg-[#0066ff] dark:bg-[#4d94ff]', stroke: 'stroke-[#0066ff] dark:stroke-[#4d94ff]' },
  { fill: 'fill-[#8b5cf6] dark:fill-[#a78bfa]', bg: 'bg-[#8b5cf6] dark:bg-[#a78bfa]', stroke: 'stroke-[#8b5cf6] dark:stroke-[#a78bfa]' },
  { fill: 'fill-[#d97706] dark:fill-[#fbbf24]', bg: 'bg-[#d97706] dark:bg-[#fbbf24]', stroke: 'stroke-[#d97706] dark:stroke-[#fbbf24]' },
  { fill: 'fill-[#10b981] dark:fill-[#34d399]', bg: 'bg-[#10b981] dark:bg-[#34d399]', stroke: 'stroke-[#10b981] dark:stroke-[#34d399]' },
  { fill: 'fill-[#db2777] dark:fill-[#f472b6]', bg: 'bg-[#db2777] dark:bg-[#f472b6]', stroke: 'stroke-[#db2777] dark:stroke-[#f472b6]' },
] as const;

/** The chart keeps four models and stacks the rest as one layer: the fifth tone is that layer's, in the rows too. */
export function toneAt(i: number): (typeof TONES)[number] {
  return TONES[Math.min(i, TONES.length - 1)]!;
}

/** «182M», «840k»: a token figure in a row, number and unit together. */
export function tokensShort(n: number, locale: string): string {
  const t = tokenParts(n, locale);
  return `${t.value}${t.unit}`;
}

/** A percent in the locale's way, one decimal at most. */
export function pctText(v: number, locale: string): string {
  return `${v.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { maximumFractionDigits: 1 })}%`;
}

/** «gio 12:40»: when something last happened, short. */
export function whenText(ms: number, locale: string): string {
  return new Date(ms).toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export function modelName(key: string, tr: Tr): string {
  return key === 'other' ? tr('hubUsage.other') : friendlyModelLabel(key);
}

/** A round top for an axis: 1, 2 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
