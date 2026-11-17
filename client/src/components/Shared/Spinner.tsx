/**
 * The app's loading glyph, in one place: always the square loader
 * (`SparkLoader`), the one status icon of Topics.
 *
 * It used to be a CSS ring copied 24 times in 10 files, then a ring for some
 * sizes and the loader for others, next to lucide's `Loader2` turning inside
 * buttons. Three glyphs for the same wait. Now every wait draws the same body
 * of squares; what changes is the movement (`activity`) and the size.
 *
 * SIZES: three named ones plus a number for the few surfaces that had a
 * bigger glyph (a whole browser pane waiting). `box` keeps the footprint of
 * the icon this replaced: a 12px glyph in the 13/14px slot of the lucide icon
 * it swaps with, so a button does not jump when its icon becomes the loader.
 */
import { SparkLoader } from '../Layout/StreamingIndicator';
import type { LoaderActivity } from '../Layout/squareLoader';

const SIZES = {
  /** Inside a narrow button, next to a 10px icon. */
  xs: 10,
  /** The default: list rows, section headers, buttons. */
  sm: 12,
  /** A whole panel loading. */
  md: 16,
} as const;

/**
 * The colour.
 *  · `default` — the app's working ink (primary): the neutral wait of a block.
 *  · `current` — inherits the text colour of the caller, for the glyph INSIDE a
 *                coloured button or row (`text-white`, `text-red-500`).
 */
export type SpinnerSize = keyof typeof SIZES;
export type SpinnerTone = 'default' | 'current';

export function Spinner({ size = 'sm', tone = 'default', activity = 'sync', box, decorative = false, className = '' }: {
  size?: SpinnerSize | number;
  tone?: SpinnerTone;
  /** The movement. `sync` for a generic load (data, network, update); `wait` for an answer of the user; `tool` for an agent at work. */
  activity?: LoaderActivity;
  /** Footprint in px when it must match the icon it replaces; the glyph is centred in it. */
  box?: number;
  /**
   * The glyph only, no status of its own: for a loader that sits INSIDE a
   * region that already announces the wait (a `role="status"` line with its
   * own words). Two nested live regions read the wait twice.
   */
  decorative?: boolean;
  className?: string;
}) {
  const px = typeof size === 'number' ? size : SIZES[size];
  const slot = Math.max(box ?? px, px);
  // SparkLoader paints its own ink class; `!text-current` makes the canvas read
  // the caller's colour instead, without touching the approved component.
  // The label is in English like the other waiting surfaces ("Loading..." in
  // App.tsx, GitChanges): a screen reader would otherwise mix two languages.
  return (
    <span
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : 'Loading'}
      aria-hidden={decorative ? true : undefined}
      // The one hook e2e specs use to find a wait (the ring used to be `.animate-spin`).
      data-spinner=""
      className={`inline-flex flex-shrink-0 items-center justify-center ${className}`}
      style={slot === px ? undefined : { width: slot, height: slot }}
    >
      <SparkLoader size={px} activity={activity} className={tone === 'current' ? '!text-current' : ''} />
    </span>
  );
}

/**
 * The loader centred in the space it has: the `Suspense` fallback of a pane or
 * a lazy panel. `h-full` fills the parent's box; `fill` puts it in a flex
 * that takes the remaining space, the shape panels inside a column need.
 */
export function SpinnerFallback({ fill = false }: { fill?: boolean }) {
  return (
    <div className={fill ? 'flex-1 flex items-center justify-center py-8' : 'flex items-center justify-center h-full'}>
      <Spinner size="md" />
    </div>
  );
}
