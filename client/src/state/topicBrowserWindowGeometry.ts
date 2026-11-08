/**
 * topicBrowserWindowGeometry — sizes and placement of a topic's browser window,
 * as pure functions: the bounds the reducers clamp against, and where the
 * minimized window really sits inside the topic area (anchored to the
 * bottom-right corner, clear of the composer). No state, no I/O.
 */

import { MIN_EXPANDED_WIDTH } from '../components/Browser/topicBrowserWindowLazy';
import type { TopicBrowserSize, TopicBrowserWindowState } from './topicBrowserWindow';

/** Default size of the minimized window, and the bounds of the expanded one.
 *  They live here because the position/width reducers clamp against them. */
export const MIN_WINDOW_SIZE = { width: 420, height: 320 } as const;
/** How far the minimized window can be shrunk or grown from its edges. The
 *  floor keeps the bar's buttons and a readable page; the area itself is the
 *  real ceiling (`resolveMinRect` clips to it), this one only rejects garbage. */
export const MIN_WINDOW_SIZE_BOUNDS = {
  min: { width: 280, height: 200 },
  max: { width: 4096, height: 4096 },
} as const;
export const EXPANDED_WIDTH_BOUNDS = { min: MIN_EXPANDED_WIDTH, max: 1200 } as const;

export const clampSize = (size: TopicBrowserSize): TopicBrowserSize => ({
  width: Math.round(Math.max(MIN_WINDOW_SIZE_BOUNDS.min.width, Math.min(MIN_WINDOW_SIZE_BOUNDS.max.width, size.width))),
  height: Math.round(Math.max(MIN_WINDOW_SIZE_BOUNDS.min.height, Math.min(MIN_WINDOW_SIZE_BOUNDS.max.height, size.height))),
});

/** The size the minimized window asks for: its own, or the default. */
export function floatingSizeOf(state: TopicBrowserWindowState): TopicBrowserSize {
  return state.minSize ?? MIN_WINDOW_SIZE;
}

/** Breathing room between the floating window and the edges of the area, and
 *  between the floating window and the composer below it. */
export const FLOAT_MARGIN_PX = 24;

/** The composer, as an obstacle: where its BAR lies inside the area (px from
 *  the top) and whether the topic is still empty, which centres it. */
export type ComposerBand = { top: number; bottom: number; centered: boolean };

/** Where the window may sit so it does not cover the composer: `floor` is the
 *  lowest `bottom` a drag may reach, `defaultBottom` the one it starts from.
 *
 *  Two cases, and the difference is measured, not assumed. A DOCKED composer
 *  leaves no room underneath, so the window climbs above its bar. A CENTRED
 *  composer (an empty topic) leaves the whole lower half free, so the window
 *  keeps the bottom corner, tucked just under the bar when the corner itself
 *  would touch it.
 *
 *  The floor is NOT applied while the composer is centred: there the free band
 *  is 18px tall (measured at 1280x800), a clamp would pin the window and kill
 *  the vertical drag, and the state is transient anyway since the composer
 *  docks with the first message. */
export function resolveComposerAvoidance(
  area: { height: number; composer?: ComposerBand },
  height: number,
): { floor: number; defaultBottom: number } {
  const band = area.composer;
  if (!band || band.bottom <= band.top) return { floor: 0, defaultBottom: FLOAT_MARGIN_PX };
  const below = area.height - band.bottom;
  if (below >= height) {
    return { floor: 0, defaultBottom: Math.min(FLOAT_MARGIN_PX, Math.round(below - height)) };
  }
  const climb = Math.max(0, Math.round(area.height - band.top));
  return { floor: band.centered ? 0 : climb + FLOAT_MARGIN_PX, defaultBottom: climb + FLOAT_MARGIN_PX };
}

/** Where the minimized window really sits, given the size of the topic area.
 *  Anchored to the bottom-right: a narrower area moves `left`, never the
 *  distance from the corner, which is why the window survives a resize.
 *
 *  `area.composer` is the composer as an obstacle. The window does not cover
 *  it: the default corner used to be 24px from the bottom, which in a 1280x800
 *  topic put the window right on the send button, covered in every topic
 *  since the first delivery.
 *  The button reads «Invia il messaggio». allow-italian: quoted UI label
 *  A floating window is not allowed to stand between a person and sending
 *  their message.
 *
 *  When the area is too short for either side the window keeps what is left,
 *  instead of being pushed out of the top. */
export function resolveMinRect(
  state: TopicBrowserWindowState,
  area: { width: number; height: number; composer?: ComposerBand },
  size: { width: number; height: number } = floatingSizeOf(state),
): { left: number; top: number; width: number; height: number } {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const avoid = resolveComposerAvoidance(area, height);
  const pos = state.minPos ?? { right: FLOAT_MARGIN_PX, bottom: avoid.defaultBottom };
  const right = Math.min(pos.right, Math.max(0, area.width - width));
  const maxBottom = Math.max(0, area.height - height);
  const minBottom = Math.min(avoid.floor, maxBottom);
  const bottom = Math.min(Math.max(pos.bottom, minBottom), maxBottom);
  return { left: area.width - right - width, top: area.height - bottom - height, width, height };
}
