import { useEffect } from 'react';
import { useRefMirror } from '../../hooks/useRefMirror';
import { TOGGLE_PANE_ZOOM_EVENT, type TogglePaneZoomDetail } from '../../hooks/useKeyboardShortcuts';
import type { ZoomScope } from './zoomScope';

/**
 * usePaneZoomChord - the OTHER END of the zoom chord, one shape for both grids.
 *
 * `useKeyboardShortcuts` turns Cmd-E / Alt-Cmd-E into a cancelable
 * `topics:toggle-pane-zoom` on `window` and stops there: an App-level shortcut
 * cannot reach the surface that owns the zoom without threading a callback
 * through every component in between. This is the listener that answers it, and
 * it lives in ONE function so the standalone grid and the project grid answer
 * with the same code instead of two lookalikes that drift.
 *
 * IN ITS OWN MODULE, and not inside either grid, because the two grids are
 * component files: `react-refresh/only-export-components` fails the lint on a
 * component file that also exports a hook, and the rule's own message is the
 * instruction followed here ("use a new file to share functions between
 * components").
 *
 * WHO CLAIMS THE CHORD. `detail.panelId` is the App-level focused PANEL, so the
 * INNERMOST surface wins: a project window claims it when that panel is its own,
 * and the standalone grid stands down for a panel a project window has taken.
 * `preventDefault()` on the cancelable event is how a surface says "mine", and
 * `defaultPrevented` is how the next one knows to keep its hands off.
 *
 * WHY THE OUTER SURFACE ANSWERS A MICROTASK LATE. Every `window` listener runs
 * synchronously during dispatch, in REGISTRATION order, and registration order
 * is mount order: a project window opened after the grid registers second, so
 * the grid would claim a chord aimed at a surface nested inside it. Deferring
 * the outer answer to a microtask puts it strictly after every listener however
 * they mounted, and it keeps the fallback that matters - when the inner surface
 * declines (one live cell, nothing to reveal) the outer one still gets to
 * enlarge the cell that HOSTS it.
 *
 * Handling it is not compulsory: on a surface with a single live cell there is
 * nothing to take away and the chord enlarges nothing, which is an outcome and
 * not a failure (LAYOUT-34).
 *
 * @param enabled  the surface offers the command at all (the 768px gate, and
 *                 `enableZoom` where the host decides it).
 * @param outer    this surface can contain another zoomable one, so it waits.
 * @param resolveAnchor  the pane to anchor on for this App-level panel, or
 *                 `null` when the chord is not this surface's business.
 * @param toggle   enter or leave; `false` = it did nothing, so the chord stays
 *                 unclaimed and an outer surface may still answer it.
 */
export function usePaneZoomChord(
  enabled: boolean,
  outer: boolean,
  resolveAnchor: (panelId: string | null) => string | null,
  toggle: (paneId: string, scope: ZoomScope) => boolean,
): void {
  // MIRRORED, so the subscription is made ONCE and not on every render. Both
  // callbacks close over the surface's live layout, so on a grid with a
  // streaming turn in it their identity changes several times a second: with
  // them in the dependency array this listener would be torn down and
  // re-attached at that rate, for nothing. The refs are written during render,
  // so a chord arriving after any render reads that render's answer.
  const anchorRef = useRefMirror(resolveAnchor);
  const toggleRef = useRefMirror(toggle);
  useEffect(() => {
    if (!enabled) return;
    const onChord = (e: Event): void => {
      const ev = e as CustomEvent<TogglePaneZoomDetail>;
      const detail = ev.detail;
      if (!detail) return;
      const claim = (): void => {
        if (ev.defaultPrevented) return;
        const paneId = anchorRef.current(detail.panelId);
        if (!paneId) return;
        if (toggleRef.current(paneId, detail.scope)) ev.preventDefault();
      };
      if (outer) queueMicrotask(claim);
      else claim();
    };
    window.addEventListener(TOGGLE_PANE_ZOOM_EVENT, onChord);
    return () => window.removeEventListener(TOGGLE_PANE_ZOOM_EVENT, onChord);
  }, [enabled, outer, anchorRef, toggleRef]);
}
