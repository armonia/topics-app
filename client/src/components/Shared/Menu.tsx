import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useMobile } from '../../hooks/useMobile';
import { useDismissable } from '../../hooks/useDismissable';
import { computeMenuPosition } from '@/lib/popoverPosition';
import { POPOVER_SURFACE, POPOVER_SHEET, Z_POPOVER, Z_POPOVER_SCRIM } from '@/lib/popoverStyles';

/**
 * Menu — the ONE anchored-popover primitive. Every custom menu / dropdown in the
 * app should route through here (directly or via the `DropdownPortal` wrapper) so
 * they all inherit, for free and identically:
 *   - a portal to <body> (escapes parent `overflow`/stacking contexts),
 *   - viewport-aware placement with flip-above + horizontal clamp (`computeMenuPosition`),
 *   - the `useDismissable` contract (outside-pointer close, Escape, focus-restore),
 *   - roving keyboard nav (Arrow/Home/End) over real focusable items,
 *   - `role="menu"`/`"listbox"` + `.glass-surface` — the double marker
 *     `browserOcclusion.OVERLAY_SELECTOR` needs to lift the menu over native panes,
 *   - the mobile bottom-sheet, and the tokenised `Z_POPOVER` layer.
 *
 * Look is unchanged: it reuses the canonical `POPOVER_SURFACE`/`POPOVER_SHEET`.
 */

// Real, individually-focusable rows. Buttons qualify without needing an explicit
// role, so existing button-based menus become keyboard-navigable unchanged; a
// menu that adds role="menuitem"/"option" gets proper semantics on top.
const ITEM_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]), [role="option"]:not([aria-disabled="true"]), button:not([disabled])';

export interface MenuProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
  /** Which trigger edge the menu aligns to (default 'left'). */
  align?: 'left' | 'right';
  /** Container role — 'menu' for action menus, 'listbox' for pickers. Default 'menu'. */
  role?: 'menu' | 'listbox';
  /** Desktop min panel width in px (default 150). */
  minWidth?: number;
  /** Extra class names appended to the desktop panel. */
  className?: string;
  /** Let the panel own its focus + keyboard (e.g. a search field + custom list).
   *  Disables the container auto-focus and roving-tabindex. Default false. */
  unmanagedFocus?: boolean;
  /** Return focus to the trigger on close (default true). */
  restoreFocus?: boolean;
  /** Extra nodes that count as "inside" for dismissal (nested panels/menus). */
  extraRefs?: Array<React.RefObject<HTMLElement | null>>;
}

export function Menu({
  open,
  anchorRef,
  onClose,
  children,
  align = 'left',
  role = 'menu',
  minWidth = 150,
  className = '',
  unmanagedFocus = false,
  restoreFocus = true,
  extraRefs,
}: MenuProps) {
  const { isMobile } = useMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Dismissal: trigger + panel (+ any caller sub-panels) are "inside".
  useDismissable({
    open,
    onClose,
    refs: [anchorRef, panelRef, ...(extraRefs ?? [])],
    restoreFocus,
  });

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const next = computeMenuPosition(a, { width: p.width, height: p.height }, { align });
    setPos({ top: next.top, left: next.left });
  }, [anchorRef, align]);

  // Measure the real panel and place it BEFORE paint; keep it placed while open.
  useLayoutEffect(() => {
    if (!open || isMobile) {
      // Clear the measured position when hidden so the next open re-measures
      // from scratch; paired with reposition()'s measure below.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPos(null);
      return;
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, isMobile, reposition]);

  // Move focus INTO the menu on open (container, tabIndex=-1) so Arrow keys work
  // and screen readers announce it — no per-item ring for mouse users.
  useEffect(() => {
    if (!open || unmanagedFocus || isMobile) return;
    panelRef.current?.focus({ preventScroll: true });
  }, [open, unmanagedFocus, isMobile]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (unmanagedFocus) return;
      const panel = panelRef.current;
      if (!panel) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
      if (items.length === 0) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const target =
        e.key === 'Home' ? 0
        : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (idx < 0 ? 0 : (idx + 1) % items.length)
        : idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
      items[target]?.focus();
    },
    [unmanagedFocus],
  );

  if (!open) return null;

  return createPortal(
    <>
      {isMobile && (
        <div className="fixed inset-0" style={{ zIndex: Z_POPOVER_SCRIM }} onClick={onClose} />
      )}
      <div
        ref={panelRef}
        role={role}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={
          isMobile
            ? `fixed bottom-0 left-0 right-0 ${POPOVER_SHEET} outline-none`
            : `${POPOVER_SURFACE} outline-none ${className}`
        }
        style={
          isMobile
            ? { zIndex: Z_POPOVER, paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)' }
            : {
                position: 'fixed',
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                minWidth,
                zIndex: Z_POPOVER,
                // Hidden for the one layout pass before we've measured, so the
                // menu never flashes at the guess position.
                visibility: pos ? 'visible' : 'hidden',
              }
        }
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
