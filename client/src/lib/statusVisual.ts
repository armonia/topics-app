import { Activity, CircleAlert, CircleCheck, TriangleAlert, type LucideIcon } from 'lucide-react';

/**
 * statusVisual: ONE colour and ONE icon per meaning, on every surface.
 *
 * Four states, and only four:
 *
 *   wait     amber    something waits for YOU (an answer, a decision)
 *   working  sky      an agent is on it (the same blue as the in_progress column)
 *   danger   red      it failed, it was stopped, it errored
 *   ok       emerald  done, healthy, connected
 *
 * Rose is NOT a state. It is the colour of the Review column (`STATUS_ICON_COLOR`
 * in `components/Board/constants.ts`) and nothing else: "awaiting you" used to
 * be rose on the Board and amber in the sidebar, "failed" rose on the card and
 * red in the detail, "working" green in the Agents pane and blue on the Board.
 * Same meaning, same colour: this module is where that rule lives.
 *
 * Each state has one token per SURFACE, because the right ramp step is not the
 * same in the two themes nor for text and graphics:
 *
 *   STATUS_DOT   small dots and glyphs: graphics, WCAG 3:1
 *   STATUS_INK   coloured text on the chrome or a card: text, WCAG 4.5:1
 *   STATUS_CHIP  a tinted chip (`-500/15` veil + its text): text on the veil, 4.5:1
 *
 * Measured with the Tailwind v4 palette (oklch converted to sRGB) against the
 * real surfaces of `index.css`: the chrome (`--chrome-bg`, #ecedee light,
 * #080a0e dark) and the card (`--bg-elevated`, #fafafa light, #222325 dark).
 * The chip is measured on its veil composited over the card.
 *
 *   DOT                 chrome light/dark    card light/dark
 *   amber-700/400        4.31 / 11.52         4.84 /  9.14
 *   sky-600/400          3.42 /  9.06         3.85 /  7.19
 *   red-500/400          3.26 /  6.84         3.66 /  5.43
 *   emerald-600/400      3.12 / 10.24         3.51 /  8.12
 *
 *   INK
 *   amber-800/400        6.08 / 11.52         6.84 /  9.14
 *   sky-800/400          6.41 /  9.06         7.21 /  7.19
 *   red-700/400          5.47 /  6.84         6.15 /  5.43
 *   emerald-800/400      6.46 / 10.24         7.27 /  8.12
 *
 *   CHIP (text on the -500/15 veil over the card, light/dark)
 *   amber-800/300        6.11 / 8.22
 *   sky-800/300          6.21 / 7.51
 *   red-800/300          6.48 / 7.17
 *   emerald-800/300      6.33 / 8.11
 *
 * The 500 ramp alone (`text-amber-500`, `bg-red-500`) is what this replaces:
 * amber-500 is 1.83:1 on the light chrome, a colour you guess instead of read.
 * `statusVisual.test.ts` recomputes every number above from the Tailwind theme,
 * so a token cannot drift under its threshold silently.
 */
export type StatusTone = 'wait' | 'working' | 'danger' | 'ok';

export const STATUS_DOT = {
  wait: 'bg-amber-700 dark:bg-amber-400',
  working: 'bg-sky-600 dark:bg-sky-400',
  danger: 'bg-red-500 dark:bg-red-400',
  ok: 'bg-emerald-600 dark:bg-emerald-400',
} as const satisfies Record<StatusTone, string>;

export const STATUS_INK = {
  wait: 'text-amber-800 dark:text-amber-400',
  working: 'text-sky-800 dark:text-sky-400',
  danger: 'text-red-700 dark:text-red-400',
  ok: 'text-emerald-800 dark:text-emerald-400',
} as const satisfies Record<StatusTone, string>;

export const STATUS_CHIP = {
  wait: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  working: 'bg-sky-500/15 text-sky-800 dark:text-sky-300',
  danger: 'bg-red-500/15 text-red-800 dark:text-red-300',
  ok: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
} as const satisfies Record<StatusTone, string>;

/** The glyph of each state. `wait` is the "it is your turn" mark, which is why
 *  it is not an hourglass: an hourglass says "time passes", and a turn stopped
 *  on you does not pass by itself. */
export const STATUS_ICON = {
  wait: CircleAlert,
  working: Activity,
  danger: TriangleAlert,
  ok: CircleCheck,
} as const satisfies Record<StatusTone, LucideIcon>;
