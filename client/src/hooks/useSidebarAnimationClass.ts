import { useEffect } from 'react';
import { isTauri } from '../lib/shell';

/**
 * Keeps the sidebar collapse/expand smooth on WebKit (Tauri) by taking the DOM
 * terminals out of the layout for the slide.
 *
 * Why: animating the sidebar `width` resizes the sibling content area every frame,
 * and WebKit re-flows every mounted xterm on each frame — ~300ms for 6 terminals,
 * i.e. the "performance scende aprendo/chiudendo la sidebar" jank. The CSS rule
 * `html.sidebar-animating .xterm { content-visibility: hidden }` skips their layout
 * for the ~200ms slide, so the slide itself stays smooth (measured: ~3 → ~13
 * frames per 450ms window). The terminals lay out once when the class is dropped on
 * transitionend — the single re-fit the end-of-resize performs anyway, instead of
 * one per animation frame. (Revealing them gradually was measured WORSE: each reveal
 * re-flows the whole flex row, so all-at-once is optimal.)
 *
 * Gated to Tauri — Chromium (Electron) lays these out fast enough not to need it, so
 * its behaviour is left exactly as it was.
 */
export function useSidebarAnimationClass(): void {
  useEffect(() => {
    if (!isTauri) return;
    const root = document.documentElement;
    const sidebar = () =>
      document.querySelector<HTMLElement>('[role="navigation"][aria-label="Topics sidebar"]');
    const isSidebarWidth = (e: TransitionEvent) =>
      e.propertyName === 'width' && e.target instanceof Element && e.target === sidebar();

    let safety = 0;
    const start = (e: TransitionEvent) => {
      if (!isSidebarWidth(e)) return;
      root.classList.add('sidebar-animating');
      // If transitionend never arrives (interrupted/cancelled transition that emits
      // no event), drop the freeze after the longest plausible slide so the terminals
      // can't stay hidden.
      clearTimeout(safety);
      safety = window.setTimeout(() => root.classList.remove('sidebar-animating'), 500);
    };
    const end = (e: TransitionEvent) => {
      if (!isSidebarWidth(e)) return;
      clearTimeout(safety);
      root.classList.remove('sidebar-animating');
    };

    document.addEventListener('transitionrun', start, true);
    document.addEventListener('transitionend', end, true);
    document.addEventListener('transitioncancel', end, true);
    return () => {
      document.removeEventListener('transitionrun', start, true);
      document.removeEventListener('transitionend', end, true);
      document.removeEventListener('transitioncancel', end, true);
      clearTimeout(safety);
      root.classList.remove('sidebar-animating');
    };
  }, []);
}
