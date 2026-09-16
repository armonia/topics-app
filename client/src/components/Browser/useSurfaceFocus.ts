/**
 * The focus of a surface the pane store does not track: the topic browser
 * window, drawn over or beside the chat of its topic.
 *
 * A pointerdown or a focusin anywhere in the document takes the focus away (a
 * native capture listener on `document`), and the same event inside the surface
 * gives it back through `captureProps`, which React runs later in the same
 * dispatch. React events follow the component tree, so a menu the surface
 * portals elsewhere still counts as inside. A click inside a native page never
 * reaches the DOM: the mount site passes `claim` as `onSelfFocus`.
 *
 * A heavy page in the window pauses once the person goes back to the chat, and
 * comes back when they touch the window again (BROWSER-HEAVY-03).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface SurfaceFocus {
  focused: boolean;
  claim: () => void;
  captureProps: { onPointerDownCapture: () => void; onFocusCapture: () => void };
}

/** `initial`: a window opens because someone just asked for its page. */
export function useSurfaceFocus(initial = true): SurfaceFocus {
  const [focused, setFocused] = useState(initial);
  const claim = useCallback(() => setFocused(true), []);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const release = () => setFocused(false);
    document.addEventListener('pointerdown', release, true);
    document.addEventListener('focusin', release, true);
    return () => {
      document.removeEventListener('pointerdown', release, true);
      document.removeEventListener('focusin', release, true);
    };
  }, []);
  const captureProps = useMemo(() => ({ onPointerDownCapture: claim, onFocusCapture: claim }), [claim]);
  return { focused, claim, captureProps };
}
