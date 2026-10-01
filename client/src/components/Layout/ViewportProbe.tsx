import { useEffect, useState } from 'react';

/**
 * TEST BUILD ONLY: a small readout of the numbers that decide between `black`
 * and `black-translucent`, so one screenshot from the phone answers what no
 * headless WebKit can: innerHeight against the screen, the real safe-area
 * insets, and the floor the root took. Mobile only, never in the way of a tap.
 */
export function ViewportProbe({ floor }: { floor: number | null }) {
  const [line, setLine] = useState('');
  useEffect(() => {
    const read = () => {
      // env() is only resolved on a real property, not on a custom one.
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const top = Math.round(parseFloat(cs.paddingTop) || 0);
      const bottom = Math.round(parseFloat(cs.paddingBottom) || 0);
      probe.remove();
      const vv = window.visualViewport;
      setLine([
        `ih ${window.innerHeight}`,
        `vv ${vv ? Math.round(vv.height) : '-'}`,
        `screen ${screen.width}x${screen.height}`,
        `sat ${top}`,
        `sab ${bottom}`,
        `floor ${floor ?? '-'}`,
        `root ${Math.round(document.querySelector('[data-app-root]')?.getBoundingClientRect().height ?? 0)}`,
      ].join(' · '));
    };
    read();
    window.addEventListener('resize', read);
    const t = window.setInterval(read, 2000);
    return () => { window.removeEventListener('resize', read); window.clearInterval(t); };
  }, [floor]);
  return (
    <div
      data-testid="viewport-probe"
      className="pointer-events-none fixed right-2 z-[60] rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-white"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 60px)' }}
    >
      {line}
    </div>
  );
}
