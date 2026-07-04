/**
 * popoverPosition — ONE viewport-aware placement function for every anchored
 * menu / dropdown / popover. Generalised from `PaneAddMenu.computeAnchor` (the
 * one call-site that already did clamp + flip correctly) so the rest stop
 * hand-rolling half of it: `DropdownPortal` had no flip (menus clipped at the
 * bottom edge), and ContextMenu / FileExplorer / GitChanges each re-derived a
 * slightly different clamp. Pure + viewport-injectable so it unit-tests without a DOM.
 */

/** The trigger's viewport-relative box (a DOMRect works as-is). */
export interface AnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface ComputeMenuPositionOpts {
  /** Which trigger edge the menu's matching edge aligns to (default 'left'). */
  align?: 'left' | 'right';
  /** Gap in px between the trigger and the menu (default 4). */
  gap?: number;
  /** Viewport inset the menu must stay within (default 8). */
  margin?: number;
  /** Override the viewport (defaults to window.inner*). Injected in tests. */
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface MenuPosition {
  top: number;
  left: number;
  /** Which way the menu ended up opening — useful for transform-origin / arrows. */
  placement: 'below' | 'above';
}

/**
 * Place `menu` next to `anchor`, clamped inside the viewport, flipping above the
 * trigger when it would clip the bottom edge. Returns fixed-position coords
 * (top/left) since every popover in the app renders in a `position: fixed` portal.
 */
export function computeMenuPosition(
  anchor: AnchorRect,
  menu: MenuSize,
  opts: ComputeMenuPositionOpts = {},
): MenuPosition {
  const { align = 'left', gap = 4, margin = 8 } = opts;
  const vw = opts.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
  const vh = opts.viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 0);

  // Horizontal: align the menu's left edge to the trigger's left, or its right
  // edge to the trigger's right, then clamp so it never overflows either side.
  let left = align === 'right' ? anchor.right - menu.width : anchor.left;
  const maxLeft = vw - menu.width - margin;
  // When the menu is wider than the viewport, prefer showing its left edge.
  left = maxLeft >= margin ? Math.max(margin, Math.min(left, maxLeft)) : margin;

  // Vertical: open below by default; flip above when there isn't room below.
  const fitsBelow = anchor.bottom + gap + menu.height <= vh - margin;
  const top = fitsBelow ? anchor.bottom + gap : Math.max(margin, anchor.top - menu.height - gap);

  return { top, left, placement: fitsBelow ? 'below' : 'above' };
}
