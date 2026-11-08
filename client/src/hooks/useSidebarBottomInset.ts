import { useEffect, useState } from 'react';

/**
 * Where the sidebar's resize handle has to stop, at the top and at the bottom.
 *
 * The handle is a 10px band biased INTO the sidebar (native panes sit flush on
 * the content side and would eat anything past the edge), and it used to run the
 * full height. At the bottom that put it on top of the identity block, whose
 * rightmost control ends exactly under it: measured 2026-08-26, the last chip of
 * the band could not be clicked at all - on macOS as much as elsewhere - with
 * Playwright naming
 * the culprit, "`div.cursor-col-resize` intercepts pointer events". Nothing had
 * caught it because no test ever clicked that chip.
 *
 * The same band sat on two more controls, found by the usability audit on
 * 04/10 (`tests/e2e/usability-audit.spec.ts`, `elementFromPoint` from the
 * centre outward): the «+» at the right end of the header (its last 8px
 * answered to the handle) and the X of the version banner, which docks in the
 * slot right above the identity block. So the band now also starts under the
 * header, and ends above the banner slot when a banner is there.
 *
 * The boundaries are ASKED OF THE DOM and not written as numbers: an inset that
 * is right today goes wrong the first time a line is added there, and it would
 * go wrong in silence. Both are 0 until the elements have mounted — the old
 * full-height behaviour — so nothing depends on the order of the first paint.
 */
export function useSidebarHandleInsets(): { top: number; bottom: number } {
  const [insets, setInsets] = useState({ top: 0, bottom: 0 });
  useEffect(() => {
    const SIDEBAR = '[role="navigation"][aria-label="Topics sidebar"]';
    const measure = () => {
      const header = document.querySelector(`${SIDEBAR} .sidebar-header`);
      const block = document.querySelector('[data-testid="identity-block"]');
      const slot = document.querySelector('[data-update-slot]');
      const top = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
      // The slot is `empty:hidden`: with no banner its box is 0x0 and says nothing.
      const slotRect = slot?.getBoundingClientRect();
      const slotTop = slotRect && slotRect.height > 0 ? slotRect.top : Infinity;
      const blockTop = block ? block.getBoundingClientRect().top : Infinity;
      const edge = Math.min(slotTop, blockTop);
      const bottom = Number.isFinite(edge) ? Math.max(0, Math.round(window.innerHeight - edge)) : 0;
      setInsets((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    measure();
    // The block grows with what it has to say (the chip row appearing when
    // somebody turns up, a longer name), a banner lands in the slot or leaves
    // it, and the window changes height: all three move the boundary.
    const ro = new ResizeObserver(measure);
    for (const selector of [`${SIDEBAR} .sidebar-header`, '[data-testid="identity-block"]', '[data-update-slot]']) {
      const el = document.querySelector(selector);
      if (el) ro.observe(el);
    }
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return insets;
}
