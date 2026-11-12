import { CalendarClock, CircleAlert, Link2, Pause, type LucideIcon } from 'lucide-react';
import { DANGER_TEXT, WARNING_TEXT } from './popoverStyles';

/**
 * ONE VISUAL VOCABULARY FOR "HOW IT STANDS".
 *
 * Four meanings, one colour each, everywhere:
 *
 *   wait     amber  "it waits for you"
 *   working  sky    "it is at work"
 *   danger   red    "it failed"
 *   ok       green  "it is done / fine" (never "at work")
 *
 * Rose is NOT a status colour: it stays only as the Review column hue.
 *
 * `ink` is text and glyphs, `dot` is a graphic. The two differ because the
 * thresholds do (4.5:1 for text, 3:1 for graphics) and because a six pixel dot
 * that is too dark stops reading as a colour. Pairs that were identical on every
 * surface live in `popoverStyles` and are re-exported here; the variants below
 * were measured per surface and keep their own names.
 *
 * Measured on the sidebar chrome (#eaecf0 light, #080a0e dark), from the
 * Tailwind v4 oklch values converted to sRGB (WCAG 2 relative luminance):
 *
 *   sky-800 / sky-400          text   6.35 / 9.07
 *   sky-600 / sky-400          dot    3.40 / 9.07
 *   amber-700 / amber-400      dot    4.27 / 11.54
 *   emerald-600 / emerald-400  dot    3.10 / 10.25
 *   red-500 / red-400          dot    3.23 / 6.85
 *
 * CHROME-SIGNAL-01 (tests/e2e/board-theme.spec.ts) measures the same pairs in
 * the real sidebar.
 */
export const STATUS_INK = {
  wait: WARNING_TEXT,
  working: 'text-sky-800 dark:text-sky-400',
  danger: DANGER_TEXT,
  ok: 'text-emerald-800 dark:text-emerald-400',
} as const;

export const STATUS_DOT = {
  wait: 'bg-amber-700 dark:bg-amber-400',
  working: 'bg-sky-600 dark:bg-sky-400',
  danger: 'bg-red-500 dark:bg-red-400',
  ok: 'bg-emerald-600 dark:bg-emerald-400',
} as const;

/** Chip surface tints for a coloured pill on a card (light 800 / dark 300 text). */
export const STATUS_CHIP = {
  wait: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  working: 'bg-sky-500/15 text-sky-800 dark:text-sky-300',
  danger: 'bg-red-500/15 text-red-800 dark:text-red-300',
  ok: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
} as const;

/** One icon per meaning: Hourglass is retired, each of its jobs got its own glyph. */
export const STATUS_ICON = {
  /** Waits for you. */
  wait: CircleAlert,
  /** Postponed: back in the queue until a window elapses. */
  postponed: CalendarClock,
  /** Others are waiting on this one. */
  blocking: Link2,
  /** The agent is stopped, idle. */
  paused: Pause,
} as const satisfies Record<string, LucideIcon>;
