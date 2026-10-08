/**
 * THE BOX OF A PICTURE BEFORE ITS BYTES.
 *
 * A chat picture is an `<img class="max-w-full max-h-80">` with no size: zero
 * pixels tall until it loads, and then everything under it moves. A reply with
 * a picture, landed while the reader was away, measured CLS 0.034 against a
 * contract of 0.01 (cloud-quality-pass, T1/T7). The server now sends each
 * picture's size with its message (`mediaSizes`, `server/lib/media-size.ts`),
 * and this is the box that size gives.
 *
 * THE SAME BOX THE BROWSER WILL DRAW. With both dimensions `auto`, a replaced
 * element under `max-width: 100%` and `max-height: 20rem` (`max-h-80`) is scaled
 * down, ratio kept, by the tighter of the two limits, and never scaled up. So
 * its width is the smallest of: the column, its own width, and the width that
 * makes it `max-h-80` tall. `aspect-ratio` gives the height from that width.
 * The column is left to the `max-w-full` of the class, NOT written in the
 * `width`: a bubble is as wide as its content, and a percentage inside it is
 * resolved against the width of the text. Measured: a 900x500 picture drawn
 * 336x187 before its load and 576x320 after, 133 px of jump.
 * The style is meant for the time BEFORE the load: once the picture is there it
 * goes back to sizing itself, so a file whose laid-out size differs from its
 * header (a density-corrected JPEG) is drawn as it always was.
 *
 * No size, an unusable one, or a server that does not send them: no style, and
 * the picture behaves exactly as before.
 */
import { createContext, useContext } from 'react';

export type MediaSize = [number, number];
export type MediaSizes = Record<string, MediaSize>;

/** The sizes of the pictures of the message being drawn, by path. */
export const MediaSizesContext = createContext<MediaSizes | undefined>(undefined);

const MAX_SIDE = 100_000;

function usable(size: unknown): size is MediaSize {
  if (!Array.isArray(size) || size.length !== 2) return false;
  const [w, h] = size as unknown[];
  return typeof w === 'number' && typeof h === 'number'
    && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE;
}

/** The pre-load box of a `max-w-full max-h-80` picture of this size. */
export function mediaBoxStyle(size: unknown): React.CSSProperties | undefined {
  if (!usable(size)) return undefined;
  const [w, h] = size;
  return {
    width: `min(${w}px, calc(var(--spacing, 0.25rem) * 80 * ${w} / ${h}))`,
    aspectRatio: `${w} / ${h}`,
  };
}

/** The pre-load box of the picture at `path` in the message being drawn, if its size is known. */
export function useMediaBox(path: string): React.CSSProperties | undefined {
  const sizes = useContext(MediaSizesContext);
  return mediaBoxStyle(sizes?.[path]);
}

/** Two size maps as one, the later winning: a `message:media` adds to the sizes the row already had. */
export function mergeMediaSizes(a: MediaSizes | undefined, b: MediaSizes | undefined): MediaSizes | undefined {
  if (!b) return a;
  if (!a) return b;
  return { ...a, ...b };
}
