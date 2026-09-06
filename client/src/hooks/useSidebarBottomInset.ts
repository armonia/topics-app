import { useEffect, useState } from 'react';

/**
 * How far up from the bottom the sidebar's resize handle has to stop.
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
 * The boundary is ASKED OF THE DOM and not written as a number: an inset that is
 * right today goes wrong the first time a line is added down there, and it would
 * go wrong in silence. Returns 0 until the block has mounted — the old
 * full-height behaviour — so nothing depends on the order of the first paint.
 */
export function useSidebarBottomInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const misura = () => {
      const block = document.querySelector('[data-testid="identity-block"]');
      setInset(block ? Math.max(0, Math.round(window.innerHeight - block.getBoundingClientRect().top)) : 0);
    };
    misura();
    // The block grows with what it has to say (the chip row appearing when
    // somebody turns up, a longer name) and the window changes height: both
    // move the boundary.
    const ro = new ResizeObserver(misura);
    const block = document.querySelector('[data-testid="identity-block"]');
    if (block) ro.observe(block);
    window.addEventListener('resize', misura);
    return () => { ro.disconnect(); window.removeEventListener('resize', misura); };
  }, []);
  return inset;
}
