/**
 * THE THREE SIGNALS OF THE BAR, MEASURED ON THE CHROME AND NOT ON A PANE.
 *
 * This row lives on the sidebar chrome (`--chrome-bg`: #eaecf0 in light,
 * #080a0e in dark), which in light mode is DARKER than a content surface.
 * The tints here were written bare on the 500 ramp (`text-amber-500`,
 * `text-emerald-500`, `text-red-500`), that is, tuned for the dark ground and
 * nothing else. Measured on the real palette (oklch to sRGB) over the chrome of
 * both themes:
 *
 *              light    dark
 *   amber-500    1.82    9.22   <- "2.1GB" in an alarm red nobody can read
 *   emerald-500  2.09    8.03
 *   red-500      3.24    5.18
 *
 * The pairs below are the fix, not a matter of taste: on the light chrome the
 * 700 ramp is not enough for amber and green (4.28 and 4.19), so the TEXT drops
 * to 800 and climbs back to 400 in dark.
 *
 *   emerald-800 / emerald-400   6.42 / 10.24
 *   amber-800   / amber-400     6.04 / 11.52
 *   red-700     / red-400       5.44 /  6.84
 *
 * THE DOTS are graphics, not text: the threshold is 3:1 and not 4.5:1, and at
 * six pixels a tint that is too dark stops reading as "green" or "amber" and
 * turns into a dirty speck. So they stay two steps higher, where they pass all
 * the same.
 *
 *   emerald-600 / emerald-400   3.10 / 10.24
 *   amber-700   / amber-400     4.28 / 11.52
 *   red-500     / red-400       3.24 /  6.84
 *
 * (The files panel, which sits on `--bg-elevated` and is therefore lighter, has
 * ITS own tuning in `lib/gitStatusColors.ts`, where the 700 ramp is enough. Two
 * surfaces, two measurements: it is the same reason the chrome re-tunes its
 * tertiary text and its borders in index.css.) */
export const SEGNALE_OK = 'text-emerald-800 dark:text-emerald-400';
export const SEGNALE_ATTESA = 'text-amber-800 dark:text-amber-400';
export const SEGNALE_GUASTO = 'text-red-700 dark:text-red-400';
export const PALLINO_OK = 'bg-emerald-600 dark:bg-emerald-400';
export const PALLINO_ATTESA = 'bg-amber-700 dark:bg-amber-400';
export const PALLINO_GUASTO = 'bg-red-500 dark:bg-red-400';
