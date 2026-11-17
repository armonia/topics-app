import { useLayoutEffect, useState, type RefObject } from 'react';

/** Gap kept between the bottom of the panel and the composer. */
const GAP_PX = 24;
/** Below this height a panel is unreadable: better to overflow a little. */
const FLOOR_PX = 200;

/**
 * How much vertical room the chat pane leaves to a block living in its list:
 * from the pane's top edge, below the chrome bar, down to the composer.
 *
 * A panel with more content than that must scroll INSIDE itself: the chat's own
 * scroll would bring it into view, but with the composer over the bottom and the
 * fade at the top its options and button ended up cut. The value does not depend
 * on the content, so it does not move when the rest of the turn arrives.
 *
 * `null` = not inside a chat pane (a task card): the caller uses its own cap.
 */
export function usePaneRoom(ref: RefObject<HTMLElement | null>): number | null {
  const [room, setRoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.closest<HTMLElement>('[data-chat-topic-id]');
    if (!el || !pane) return;
    const composer = pane.querySelector<HTMLElement>('[data-testid="chat-input-area"]');
    const measure = () => {
      const top = pane.getBoundingClientRect().top;
      const chrome = parseFloat(getComputedStyle(pane).getPropertyValue('--chrome-bar-h')) || 0;
      const bottom = composer ? composer.getBoundingClientRect().top : pane.getBoundingClientRect().bottom;
      const next = Math.max(FLOOR_PX, Math.floor(bottom - top - chrome - GAP_PX));
      setRoom((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    if (composer) ro.observe(composer);
    return () => ro.disconnect();
  }, [ref]);

  return room;
}
