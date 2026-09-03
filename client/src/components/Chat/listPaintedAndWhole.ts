/**
 * What the curtain waits for BESIDES a still geometry: at least one item
 * painted by Virtuoso, and no image inside the scroller's visible box still
 * loading. An `<img>` without a declared size is zero pixels tall until its
 * bytes arrive, and the moment they do everything under it moves — 640 px on
 * the chat measured on 2026-09-03. Images out of view are left alone: they
 * are `loading="lazy"`, so waiting for them could wait forever.
 */
export function listPaintedAndWhole(scroller: HTMLElement): boolean {
  const items = scroller.querySelector('[data-testid="virtuoso-item-list"]');
  if (!items || items.childElementCount === 0) return false;
  const box = scroller.getBoundingClientRect();
  for (const img of scroller.querySelectorAll('img')) {
    if (img.complete) continue;
    const r = img.getBoundingClientRect();
    if (r.bottom >= box.top && r.top <= box.bottom) return false;
  }
  return true;
}
