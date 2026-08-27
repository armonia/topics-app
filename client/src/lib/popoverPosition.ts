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
  /**
   * Altezza minima che il menu deve avere comunque, anche quando lo spazio
   * calcolato è meno (default 160). Sotto, il menu scorre invece di sparire:
   * un tetto di 21px non è un menu, è una fessura.
   */
  minHeight?: number;
  /** Override the viewport (defaults to window.inner*). Injected in tests. */
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface MenuPosition {
  top: number;
  left: number;
  /** Which way the menu ended up opening — useful for transform-origin / arrows. */
  placement: 'below' | 'above';
  /**
   * Quanto può essere ALTO il menu, in px, restando dentro la finestra.
   *
   * Sta qui e non nei call-site perché senza di lui il flip non basta: con 88px
   * sotto il trigger e 100px sopra, ribaltare sceglie il lato meno peggio e
   * taglia lo stesso. È la metà mancante — misurata sul difetto vero: le due
   * tendine dei rami ricavavano il tetto dallo spazio SOTTO il bottone, e con
   * le sezioni della barra collassate sotto restavano 33px, cioè maxHeight 21
   * contro un'intestazione di lista da 24,5 → ZERO righe visibili.
   *
   * Il valore è lo spazio del lato scelto, mai sotto `minHeight`: sotto quella
   * soglia un menu non mostra niente e tanto vale farlo scorrere.
   */
  maxHeight: number;
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
  const { align = 'left', gap = 4, margin = 8, minHeight = 160 } = opts;
  const vw = opts.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
  const vh = opts.viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 0);

  // Horizontal: align the menu's left edge to the trigger's left, or its right
  // edge to the trigger's right, then clamp so it never overflows either side.
  let left = align === 'right' ? anchor.right - menu.width : anchor.left;
  const maxLeft = vw - menu.width - margin;
  // When the menu is wider than the viewport, prefer showing its left edge.
  left = maxLeft >= margin ? Math.max(margin, Math.min(left, maxLeft)) : margin;

  // Vertical: open below by default; flip above when there isn't room below.
  const spaceBelow = vh - margin - (anchor.bottom + gap);
  const spaceAbove = anchor.top - gap - margin;
  const fitsBelow = menu.height <= spaceBelow;
  const top = fitsBelow ? anchor.bottom + gap : Math.max(margin, anchor.top - menu.height - gap);

  // Il tetto del lato scelto. Quando NON ci sta da nessuna parte si prende il
  // lato più capiente: ribaltare su un lato ancora più stretto sarebbe solo un
  // modo diverso di tagliare.
  const spazio = fitsBelow ? spaceBelow : Math.max(spaceAbove, spaceBelow);
  const maxHeight = Math.max(minHeight, Math.min(spazio, vh - margin * 2));

  return { top, left, placement: fitsBelow ? 'below' : 'above', maxHeight };
}
