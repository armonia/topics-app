import { useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useDismissable } from '../../hooks/useDismissable';
import { POPOVER_SURFACE, Z_CONTEXT_MENU } from '@/lib/popoverStyles';

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
 * system: portal, viewport clamp (measured from the REAL menu, not an estimate),
 * `role="menu"` + `.glass-surface` occlusion markers, the `Z_CONTEXT_MENU` token,
 * and the `useDismissable` contract (capture-phase outside-close + Escape). Route
 * every cursor context menu through here so none can be clipped again.
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
}

const MARGIN = 8;

export function ContextMenuPortal({ open, x, y, onClose, children, minWidth = 160, className = '', extraRefs, exclusive = true }: ContextMenuPortalProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Cursor menu has no persistent trigger to restore focus to.
  useDismissable({ open, onClose, refs: [menuRef, ...(extraRefs ?? [])], restoreFocus: false, exclusive });

  // Measure the real menu and clamp it inside the viewport BEFORE paint, so it
  // never spills off-screen and never flashes at the raw cursor point.
  useLayoutEffect(() => {
    // Clear the measured position on close so the next open re-measures from
    // scratch (no flash at the previous menu's spot). Paired with the measure
    // below, this reset belongs in the same layout effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) { setPos(null); return; }
    const el = menuRef.current;
    const w = el?.offsetWidth ?? minWidth;
    const h = el?.offsetHeight ?? 0;
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - w - MARGIN));
    const top = Math.max(MARGIN, Math.min(y, window.innerHeight - h - MARGIN));
    setPos({ left, top });
  }, [open, x, y, minWidth]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={`fixed ${POPOVER_SURFACE} ${className}`}
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
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
