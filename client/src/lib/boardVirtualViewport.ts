/** The element that scrolls `node`: itself, or the nearest ancestor with its own scrollbar. */
export function scrollParentOf(node: HTMLElement): HTMLElement | null {
  for (let element: HTMLElement | null = node; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return element;
  }
  return null;
}

export function readVirtualViewport(body: HTMLDivElement): { top: number; height: number } {
  const scroller = scrollParentOf(body);
  if (scroller === body) return { top: body.scrollTop, height: body.clientHeight };
  if (!scroller) return { top: 0, height: body.clientHeight };
  const bodyRect = body.getBoundingClientRect();
  const rect = scroller.getBoundingClientRect();
  const clipTop = rect.top + scroller.clientTop;
  const clipBottom = clipTop + scroller.clientHeight;
  const top = Math.max(0, clipTop - bodyRect.top);
  const bottom = Math.min(bodyRect.height, clipBottom - bodyRect.top);
  return { top: Math.floor(top / 32) * 32, height: Math.max(0, bottom - top) };
}
