export function readVirtualViewport(body: HTMLDivElement): { top: number; height: number } {
  const ownStyle = getComputedStyle(body);
  if (ownStyle.overflowY === 'auto' || ownStyle.overflowY === 'scroll') {
    return { top: body.scrollTop, height: body.clientHeight };
  }
  const bodyRect = body.getBoundingClientRect();
  for (let ancestor = body.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const overflow = getComputedStyle(ancestor).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const rect = ancestor.getBoundingClientRect();
    const clipTop = rect.top + ancestor.clientTop;
    const clipBottom = clipTop + ancestor.clientHeight;
    const top = Math.max(0, clipTop - bodyRect.top);
    const bottom = Math.min(bodyRect.height, clipBottom - bodyRect.top);
    return { top: Math.floor(top / 32) * 32, height: Math.max(0, bottom - top) };
  }
  return { top: 0, height: body.clientHeight };
}
