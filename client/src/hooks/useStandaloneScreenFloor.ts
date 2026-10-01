import { useEffect, useState } from 'react';

/**
 * TEST BUILD ONLY (branch test/safe-area-translucent-1001): the height of the
 * screen, in CSS px, when an installed iOS PWA is handed a layout viewport
 * SHORTER than the screen.
 *
 * Why it exists. Under `black-translucent` + `viewport-fit=cover` the webview
 * starts at the top glass edge but iOS sizes the window one status bar short
 * (innerHeight = screen - topInset, WebKit bug 301108, measured 797 vs 844 on
 * a 390x844 phone by other projects). Our root is `position: fixed; bottom: 0`,
 * so the shortfall shows up as a dead band at the bottom: the reason `black`
 * was chosen on 08/06 (bc92725d7). This floor lets the root take the screen's
 * height instead, so the button row stays on the glass.
 *
 * Returns null outside standalone, when the viewport already covers the
 * screen, and while the keyboard is up (the root then follows visualViewport,
 * see useSidebarAndLayout). Whether WebKit actually PAINTS past innerHeight is
 * the thing this build is for: it cannot be measured headless.
 */
export function useStandaloneScreenFloor(keyboardUp: boolean): number | null {
  const [floor, setFloor] = useState<number | null>(null);
  useEffect(() => {
    const compute = () => {
      const standalone = window.matchMedia('(display-mode: standalone)').matches
        || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      if (!standalone || keyboardUp) { setFloor(null); return; }
      // iOS does not rotate `screen`: the long side is always `height`.
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const screenH = landscape
        ? Math.min(screen.width, screen.height)
        : Math.max(screen.width, screen.height);
      setFloor(window.innerHeight < screenH ? screenH : null);
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('orientationchange', compute);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('orientationchange', compute);
    };
  }, [keyboardUp]);
  return floor;
}
