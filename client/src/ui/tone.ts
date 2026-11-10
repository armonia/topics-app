import type { Tone } from './types';

/**
 * Tone classes, taken from the Board card chips (`components/Board/Card.tsx`):
 * a 15% fill of the family with an 800 ink in light and a 300 ink in dark, so a
 * chip here and a chip on a card are the same object.
 */
export const TONE_CHIP: Record<Tone, string> = {
  neutral: 'bg-black/[0.05] text-app-text-secondary dark:bg-white/10',
  blue: 'bg-sky-500/15 text-sky-800 dark:text-sky-300',
  green: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  red: 'bg-rose-500/15 text-rose-800 dark:text-rose-300',
  violet: 'bg-violet-500/15 text-violet-800 dark:text-violet-300',
  pink: 'bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-300',
};

/** The same families as plain text on a surface, every one at 4.5:1 or more. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-app-text-secondary',
  blue: 'text-sky-700 dark:text-sky-300',
  green: 'text-emerald-700 dark:text-emerald-400',
  amber: 'text-amber-700 dark:text-amber-400',
  red: 'text-rose-600 dark:text-rose-400',
  violet: 'text-violet-700 dark:text-violet-300',
  pink: 'text-fuchsia-700 dark:text-fuchsia-300',
};
