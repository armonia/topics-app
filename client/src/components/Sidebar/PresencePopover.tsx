/**
 * THE IDENTITY CHIP PANEL: one single shell for the three dropdowns.
 *
 * The chips at the bottom of the column (me, each organisation, friends) all
 * open the SAME surface: a heading, a list of people, actions at the bottom.
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

/** The width of the panel. The same for all three, and wider than the column:
 *  the list of people carries whole names, which the sidebar would truncate.
 *  A panel that truncates exactly like the row that opened it is no help. */
const LARGHEZZA = 244;

export function PresencePopover({
  anchorEl,
  onClose,
  titolo,
  children,
  testId,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** The heading: who or what this panel is talking about. */
  titolo: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const pannello = useRef<HTMLDivElement>(null);
  const ancora = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The anchor arrives as a raw element: it is mirrored into a ref (inside an
  // effect, not during render) because `useDismissable` only counts refs as
  // "inside", and that ref is also where focus goes back on close.
  useEffect(() => { ancora.current = anchorEl; }, [anchorEl]);

  useDismissable({ open: anchorEl !== null, onClose, refs: [ancora, pannello] });

  // Measure BEFORE the paint: with `useEffect` the panel would show up in the
  // top left corner for one frame and then jump into place.
  useLayoutEffect(() => {
    if (!anchorEl || !pannello.current) return;
    const a = anchorEl.getBoundingClientRect();
    const p = pannello.current.getBoundingClientRect();
    setPos(computeMenuPosition(
      { top: a.top, right: a.right, bottom: a.bottom, left: a.left },
      { width: LARGHEZZA, height: p.height },
      { align: 'left', gap: 6 },
    ));
  }, [anchorEl]);

  if (!anchorEl) return null;

  return createPortal(
    <div
      ref={pannello}
      data-testid={testId}
      role="dialog"
      className={`fixed ${POPOVER_PANEL} overflow-hidden`}
      style={{
        width: LARGHEZZA,
        zIndex: Z_POPOVER,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Until it has been measured it stays invisible rather than blinking
        // in the corner: one frame in the wrong place is seen, and remembered.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="flex items-center gap-2 border-b border-app-border px-3 py-2 text-[11px] font-medium text-app-text">
        {titolo}
      </div>
      {children}
    </div>,
    document.body,
  );
}
