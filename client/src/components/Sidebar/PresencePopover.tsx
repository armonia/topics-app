/**
 * THE IDENTITY CHIP PANEL: one single shell for the three dropdowns.
 *
 * The chips at the bottom of the column (me, each organisation, friends) all
 * open the SAME surface: a list of people, actions at the bottom.
 * Writing it three times would have meant three widths, three ways of closing
 * and three different answers to "what happens when the list gets long", which
 * is exactly how menus that look like they come from different apps are born.
 *
 * IT OPENS UPWARDS, but not because this file decides so: `computeMenuPosition`
 * tries below first and flips above when there is no room below. These chips
 * sit against the bottom edge of the window, so flipping is the rule and not
 * the exception; if one day the block moved to the top, the panel would drop
 * downwards on its own without a single change here.
 *
 * CLOSING IS NOT WRITTEN HERE. `useDismissable` brings the outside click, the
 * Escape key, focus returning to the chip, and the "one at a time" rule, which
 * is the one that stops two organisation panels from being open together.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissable } from '@/hooks/useDismissable';
import { computeMenuPosition } from '@/lib/popoverPosition';
import { POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';
import { useExitGhost } from '@/lib/exitGhost';
import { useMenuKeyboard } from '@/hooks/useMenuKeyboard';

/** The width of the panel. The default for all of them, and wider than the
 *  column: the list of people carries whole names, which the sidebar would
 *  truncate. A panel that truncates exactly like the row that opened it is no
 *  help.
 *
 *  A PANEL MAY ASK FOR MORE, and only one does: the account panel holds two
 *  text fields, and at this width an email address is typed into a two-word
 *  window. The exception is a prop rather than a second constant here, so the
 *  number stays the argument of the panel that needs it. */
const LARGHEZZA = 244;

export function PresencePopover({
  anchorEl,
  onClose,
  children,
  testId,
  width = LARGHEZZA,
  focusFirstRow = false,
  focusRequest = 0,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
  testId?: string;
  /** Wider than the default, for a panel that holds fields and not names. */
  width?: number;
  /** Opened from the keyboard (⌘,): the focus goes to the first row instead
   *  of the panel, so Enter acts and the arrows continue from there. */
  focusFirstRow?: boolean;
  /** Changes when the panel is asked for again while already open: the
   *  focus is given again, by the same rule, without remounting anything. */
  focusRequest?: number;
}) {
  const pannello = useRef<HTMLDivElement>(null);
  const ancora = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The anchor arrives as a raw element: it is mirrored into a ref (inside an
  // effect, not during render) because `useDismissable` only counts refs as
  // "inside", and that ref is also where focus goes back on close.
  useEffect(() => { ancora.current = anchorEl; }, [anchorEl]);

  useDismissable({
    open: anchorEl !== null,
    onClose: () => {
      // This popover unmounts on close, so useDismissable never sees its
      // open=false transition. Restore before the focused menu node disappears,
      // while respecting focus already moved to another control or dialog.
      const active = document.activeElement;
      if (!active || active === document.body || pannello.current?.contains(active)) {
        anchorEl?.focus({ preventScroll: true });
      }
      onClose();
    },
    refs: [ancora, pannello],
  });
  useExitGhost(pannello, anchorEl !== null);

  // THE FIRST LEVEL LEARNS THE ARROWS (USERMENU-07). The levels had them
  // (`Menu`, `useMenuKeyboard`) and this panel had only Escape: up, down, Home
  // and End now rove over its rows with the same rule. Not from inside a text
  // field (the account's email and code), where the arrows move the caret.
  const roving = useMenuKeyboard({ panelRef: pannello });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    roving(e);
  };

  // Measure BEFORE the paint: with `useEffect` the panel would show up in the
  // top left corner for one frame and then jump into place.
  //
  // AND MEASURE AGAIN WHEN IT GROWS. Measuring once was right while every panel
  // was a list that arrived complete; the account panel is not: it opens short,
  // asks the server whether an account is linked, and gains a whole sign-in
  // form when the answer comes back. The first measurement then belonged to a
  // panel that no longer exists, and since these chips sit against the bottom
  // edge the extra height went straight out of the window: measured 1280x800,
  // the panel ended 116px below the fold, with the actions unreachable. The
  // observer costs one call per resize and puts the flip back on the real
  // height.
  useLayoutEffect(() => {
    const panel = pannello.current;
    if (!anchorEl || !panel) return;
    const measure = () => {
      const a = anchorEl.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      setPos(computeMenuPosition(
        { top: a.top, right: a.right, bottom: a.bottom, left: a.left },
        { width, height: p.height },
        { align: 'left', gap: 6 },
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchorEl, width]);

  // Focus moves INTO the panel once it is placed (a hidden element refuses
  // `focus()`), so the arrows work from the first press, as in `Menu`.
  const placed = pos !== null;
  useEffect(() => {
    if (!anchorEl || !placed) return;
    const panel = pannello.current;
    if (!panel) return;
    if (!focusFirstRow) {
      panel.focus({ preventScroll: true });
      return;
    }
    // THE FIRST ROW MAY ARRIVE LATE: the account block is a lazy chunk, so on
    // a cold open the first button in the panel is a row further down. The
    // focus follows the first row while the content settles, and the following
    // ENDS, for good, on the first of two things: the person moves the focus
    // themselves, or the row that leads the menu (`data-menu-first-row`) has
    // had it. Kept alive past that, any later change of the panel (a tail
    // updating, a row appearing above) took the focus back from where the
    // person had it.
    let given: Element | null = null;
    let done = false;
    let observer: MutationObserver | null = null;
    const stop = () => { done = true; observer?.disconnect(); };
    const follow = () => {
      if (done) return;
      const active = document.activeElement;
      if (given !== null && active !== panel && active !== given) { stop(); return; }
      const first = panel.querySelector<HTMLElement>('[role="menuitem"], button:not([disabled])') ?? panel;
      if (first !== active) {
        first.focus({ preventScroll: true });
        given = first;
      }
      if (first.matches('[data-menu-first-row]') && document.activeElement === first) stop();
    };
    follow();
    given ??= panel;
    if (done) return;
    observer = new MutationObserver(follow);
    observer.observe(panel, { childList: true, subtree: true });
    return stop;
  }, [anchorEl, placed, focusFirstRow, focusRequest]);

  if (!anchorEl) return null;

  return createPortal(
    <div
      ref={pannello}
      data-testid={testId}
      role="dialog"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`fixed ${POPOVER_PANEL} overflow-hidden outline-none`}
      style={{
        width,
        zIndex: Z_POPOVER,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Until it has been measured it stays invisible rather than blinking
        // in the corner: one frame in the wrong place is seen, and remembered.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
