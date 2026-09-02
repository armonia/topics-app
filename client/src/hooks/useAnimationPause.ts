import { useEffect } from 'react';

/**
 * Pauses every CSS keyframe animation while the window is backgrounded — i.e.
 * minimized, occluded, or simply not the focused app.
 *
 * On the large transparent-vibrancy desktop window the always-running cues keep
 * the compositor busy on EVERY frame even when nobody is looking: the `orbit-spin`
 * "working now" loaders and the `awaiting-pulse` breathers on
 * every parked-session tab/row. With many panes + an ultrawide surface that's a
 * steady GPU/CPU draw for zero benefit while the app sits in the background.
 *
 * Toggling a single root class flips `animation-play-state: paused` on all
 * animated elements (see the `.anims-paused` rule in index.css). That property is
 * compositor-safe — the switch costs one style recalc on blur/focus, NOT a
 * per-frame cost — so backgrounded idle draw drops to ~0 and resumes instantly on
 * focus. Pure paint optimisation: no layout, no React state, no effect on the
 * terminal DOM renderer, vibrancy tracking, or pane sync.
 *
 * Not Electron-gated: a backgrounded browser tab benefits identically (and
 * `visibilitychange` already fires there).
 */
export function useAnimationPause() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      // Backgrounded = the document is hidden (minimized / not the active tab) OR
      // the window doesn't hold OS focus (another app is in front).
      const inactive = document.hidden || !document.hasFocus();
      root.classList.toggle('anims-paused', inactive);
    };
    apply();
    document.addEventListener('visibilitychange', apply);
    window.addEventListener('blur', apply);
    window.addEventListener('focus', apply);
    return () => {
      document.removeEventListener('visibilitychange', apply);
      window.removeEventListener('blur', apply);
      window.removeEventListener('focus', apply);
      root.classList.remove('anims-paused');
    };
  }, []);
}
