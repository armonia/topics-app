/**
 * What the curtain waits for BESIDES a still geometry: at least one item
 * painted by Virtuoso and shown by it, and no image inside the scroller's visible box still
 * loading. An `<img>` without a declared size is zero pixels tall until its
 * bytes arrive, and the moment they do everything under it moves — 640 px on
 * the chat measured on 2026-09-03. Images out of view are left alone: they
 * are `loading="lazy"`, so waiting for them could wait forever.
 *
 * A picture drawn in its box (`data-media-box`, the size the server sent,
 * `Chat/mediaBox.ts`) already takes the place its bytes will fill: nothing
 * moves when they arrive, so it is not waited for. Waiting held a visited
 * topic with a picture at the bottom behind the curtain up to its hard cap,
 * 1270 ms against a reveal of a few frames (T7b, `topic-visited-first-frame`).
 * A picture without a box (remote, SVG, a server that sends no sizes) is
 * waited for as before.
 */
export function listPaintedAndWhole(scroller: HTMLElement): boolean {
  const items = scroller.querySelector('[data-testid="virtuoso-item-list"]');
  if (!items || items.childElementCount === 0) return false;
  // Virtuoso keeps its own item list at `visibility: hidden` until it has
  // reached `initialTopMostItemIndex`. Lifting our curtain before that showed
  // an EMPTY pane for a frame between the skeleton and the rows: measured on a
  // group switch back to a 2000-row thread (tab-switch e2e, TABSWITCH-02).
  if ((items as HTMLElement).style.visibility === 'hidden') return false;
  const box = scroller.getBoundingClientRect();
  for (const img of scroller.querySelectorAll('img:not([data-media-box])')) {
    if ((img as HTMLImageElement).complete) continue;
    const r = img.getBoundingClientRect();
    if (r.bottom >= box.top && r.top <= box.bottom) return false;
  }
  return true;
}
