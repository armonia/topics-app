import { useRef, useState, useLayoutEffect, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useDismissable } from '../../hooks/useDismissable';
import { useMenuKeyboard } from '../../hooks/useMenuKeyboard';
import { POPOVER_SURFACE, Z_CONTEXT_MENU } from '@/lib/popoverStyles';
import { useExitGhost } from '@/lib/exitGhost';
import { computeMenuPosition, placeAtPoint, type AnchorRect } from '@/lib/popoverPosition';
import { keepSystemMenuOffPanel } from '@/lib/contextMenuOrigin';

/**
 * ContextMenuPortal — the cursor-positioned sibling of `Menu`, for right-click
 * context menus (positioned at an (x, y) point rather than anchored to a trigger
 * rect). It exists because a `position: fixed` menu rendered INLINE is NOT safe:
 * if any ancestor establishes a containing block for fixed descendants (a
 * `transform` / `filter` / `will-change`), the menu is positioned AND clipped
 * relative to that ancestor — which is exactly what happened to the sidebar
 * (TopicTree) menus: the sidebar's FLIP `translateX` made itself the containing
 * block, so a `fixed` context menu got cut off at the sidebar's edge instead of
 * floating over the whole window.
 *
 * Portaling to <body> escapes that trap. This primitive bundles the full design
 * system: portal, viewport placement (measured from the REAL menu, not an
 * estimate, flipped to the other side of the pointer at an edge and placed
 * again whenever the menu changes size), `role="menu"` + `.glass-surface`
 * occlusion markers, the `Z_CONTEXT_MENU` token, and the `useDismissable`
 * contract (capture-phase outside-close + Escape + one popover at a time).
 *
 * And the right-click contract (CTXMENU-01): the focus moves into the menu so
 * the arrows walk it, goes back on close to the element that was right-clicked
 * (`lib/contextMenuOrigin`), and a right-click ON the menu does not stack the
 * system menu over it. Route every cursor context menu through here: the rail
 * in `contextMenuSurfaces.test.ts` refuses one that is not.
 */
export interface ContextMenuPortalProps {
  open: boolean;
  /** Viewport cursor coordinates (e.g. from the contextmenu event). */
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
  /** Min width in px (default 160). */
  minWidth?: number;
  /** Extra classes on the menu card. */
  className?: string;
  /** Extra nodes that count as "inside" for dismissal (nested panels). */
  extraRefs?: Array<React.RefObject<HTMLElement | null>>;
  /**
   * false = aprendosi NON chiude gli altri popover.
   *
   * Serve al menu di riga aperto DENTRO un popover già aperto (la tendina dei
   * rami in `BranchList`): il registro «un popover alla volta» riconosce un
   * figlio dal suo trigger, e il trigger di un menu al cursore è il pannello
   * stesso — che sta in un portal su `<body>`, quindi fuori dal genitore. Senza
   * questa uscita il menu chiudeva la tendina che lo ospita e moriva con lei:
   * il gesto «tieni premuto» faceva sparire tutto invece di aprire il menu.
   */
  exclusive?: boolean;
  /** `data-testid` on the panel, for the surfaces whose tests already name it. */
  testId?: string;
  /** Accessible name of the menu. */
  ariaLabel?: string;
  /**
   * Open UNDER this box instead of at the pointer, flipping above it at the
   * bottom edge: the tab menu opens under the tab whichever pixel of it was
   * right-clicked, like a dropdown. `x`/`y` are then only the first frame's
   * guess.
   */
  anchor?: AnchorRect;
}

const MARGIN = 8;

export function ContextMenuPortal({ open, x, y, onClose, children, minWidth = 160, className = '', extraRefs, exclusive = true, testId, ariaLabel, anchor }: ContextMenuPortalProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // The trigger of a cursor menu is the element that was right-clicked: it is
  // not in `refs`, `useDismissable` takes it from `lib/contextMenuOrigin`.
  useDismissable({ open, onClose, refs: [menuRef, ...(extraRefs ?? [])], exclusive });
  useExitGhost(menuRef, open);

  // The anchor as four numbers, so a caller that rebuilds the object on every
  // render does not re-place the menu on every render.
  const aTop = anchor?.top;
  const aRight = anchor?.right;
  const aBottom = anchor?.bottom;
  const aLeft = anchor?.left;
  const place = useCallback(() => {
    const el = menuRef.current;
    if (!el) return;
    const size = { width: el.offsetWidth || minWidth, height: el.offsetHeight };
    const next = aTop !== undefined && aRight !== undefined && aBottom !== undefined && aLeft !== undefined
      ? computeMenuPosition({ top: aTop, right: aRight, bottom: aBottom, left: aLeft }, size, { margin: MARGIN })
      : placeAtPoint({ x, y }, size, { margin: MARGIN });
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : { left: next.left, top: next.top }));
  }, [x, y, minWidth, aTop, aRight, aBottom, aLeft]);

  // Measure the real menu and place it BEFORE paint, so it never spills
  // off-screen and never flashes at the raw cursor point. And again whenever it
  // changes size by itself: the topic menu swaps its list for a rename field or
  // a colour grid, a confirmation grows a row, and a menu placed for its first
  // height ran off the bottom edge with its second.
  useLayoutEffect(() => {
    // Clear the measured position on close so the next open re-measures from
    // scratch (no flash at the previous menu's spot).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) { setPos(null); return; }
    place();
    const observer = new ResizeObserver(() => place());
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  // The focus goes INTO the menu once it is placed (a hidden element refuses
  // `focus()`), so Arrow/Home/End walk its items and Esc has somewhere to come
  // from. Not when something inside already took it (a rename field focuses
  // itself), and only once per open: `placed` flips from false exactly once.
  const placed = pos !== null;
  useEffect(() => {
    if (!open || !placed) return;
    const el = menuRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [open, placed]);

  const onKeyDown = useMenuKeyboard({ panelRef: menuRef });

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={ariaLabel}
      data-testid={testId}
      className={`fixed ${POPOVER_SURFACE} outline-none ${className}`}
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        minWidth,
        // Un tetto e lo scroll: senza, un menu più alto della finestra si
        // incolla a `top: MARGIN` e il resto esce sotto, irraggiungibile — il
        // clamp da solo sposta il problema, non lo toglie. Con nove voci a
        // bersaglio touch (45px l'una) bastano 380px di finestra.
        maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        zIndex: Z_CONTEXT_MENU,
        // Hidden for the one pre-measure pass so it never flashes unclamped.
        visibility: pos ? 'visible' : 'hidden',
      }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={keepSystemMenuOffPanel}
    >
      {children}
    </div>,
    document.body,
  );
}
