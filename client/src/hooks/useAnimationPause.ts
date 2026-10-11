import { useEffect } from 'react';
import { isWindowAwake, onWindowAwakeChange } from '../state/windowAwake';

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
    const apply = () => syncAnimationPause(root);
    apply();
    const stopListening = onWindowAwakeChange(apply);
    return () => {
      stopListening();
      root.classList.remove('anims-paused');
    };
  }, []);
}

/**
 * Backgrounded is `isWindowAwake()`, the predicate the polls already use, and
 * not `document.hidden || !document.hasFocus()`. A click inside a native
 * browser pane makes the child WKWebView key, and the host document reads
 * `hasFocus() === false` while the person is using the app: every loader froze,
 * the streaming chat's spinner included, until focus came back to the host
 * (08/10, "switching tab, the loaders stop"). The polls had this fixed; the
 * animations, which `state/windowAwake.ts` says must stay in step, did not.
 */
export function syncAnimationPause(root: { classList: Pick<DOMTokenList, 'toggle'> }): void {
  root.classList.toggle('anims-paused', !isWindowAwake());
}
