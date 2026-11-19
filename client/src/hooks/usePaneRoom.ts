import { useLayoutEffect, useState, type RefObject } from 'react';

/** Air kept between the bar over the pane and the top of the panel. */
const TOP_AIR_PX = 12;
/** Below this height a panel is unreadable: better to overflow a little. */
const FLOOR_PX = 200;

/**
 * How tall a block at the END of the chat list may be so that, with the chat
 * anchored at the bottom (where a fresh question always lands), the whole block
 * is visible: its top below the bar that overlays the pane, its bottom above
 * the composer.
 *
 * Measured on the list itself, not on the pane: what sits under the block (the
 * rest of the turn, the footer, the spacer that clears the composer) is already
 * inside the scroller's content, so `viewport - under - bar - air` is exactly the
 * room left, whatever the pane, the split or the composer height. The bar is the
 * list's own top gutter (`--chat-gutter`): zero when something above the list has
 * already spent it.
 *
 * A panel with more content than that must scroll INSIDE itself. The value does
 * not depend on the panel's own height (what is under it does not move with it),
 * so it does not shift when the rest of the turn arrives.
 *
 * `null` = not inside a chat list (a task card): the caller uses its own cap.
 */
export function usePaneRoom(ref: RefObject<HTMLElement | null>): number | null {
  const [room, setRoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const scroller = el?.closest<HTMLElement>('[data-virtuoso-scroller]');
    const pane = el?.closest<HTMLElement>('[data-chat-topic-id]');
    if (!el || !scroller || !pane) return;
    const composer = pane.querySelector<HTMLElement>('[data-testid="chat-input-area"]');
    const measure = () => {
      const s = scroller.getBoundingClientRect();
      const contentBottom = s.top - scroller.scrollTop + scroller.scrollHeight;
      const under = Math.max(0, contentBottom - el.getBoundingClientRect().bottom);
      const bar = parseFloat(getComputedStyle(scroller).getPropertyValue('--chat-gutter')) || 0;
      const next = Math.max(FLOOR_PX, Math.floor(scroller.clientHeight - under - bar - TOP_AIR_PX));
      setRoom((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);
    if (composer) ro.observe(composer);
    return () => ro.disconnect();
  }, [ref]);

  return room;
}
