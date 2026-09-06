import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Menu } from './Menu';
import { useMobile } from '../../hooks/useMobile';
import { menuRowClass } from '../Sidebar/menuRow';

/**
 * SubmenuItem: a menu row that opens a SECOND level beside itself.
 *
 * It is a row plus a `Menu`, nothing more, and that is the point. The nested
 * levels of the profile menu were accordions: a chevron rotating 90 degrees
 * and a list unfolding IN the same panel, which pushes every row below it
 * down and turns a two-level menu into a scrolling column. A submenu keeps
 * the host intact and opens its level where the eye already is, on the row.
 *
 * Everything that makes it behave comes from the primitive, for free:
 *   - `side="right"` places it beside the row, top edges aligned, flipping to
 *     the left edge when the right would clip (`computeMenuPosition`);
 *   - `exclusive={false}` registers it as a sub-surface, so opening it does
 *     not evict the host and a pointer on it counts as "inside" for the host
 *     (`popoverRegistry.subSurfaceNodes`);
 *   - its trigger lives inside the host panel, so the registry knows it as a
 *     CHILD: Escape closes the submenu first, one level per press
 *     (`popoverRegistry.descendantPopoverNodes`);
 *   - the portal, the glass surface, `role="menu"` (which is what lifts it
 *     over a native browser pane), the mobile bottom sheet and the z layer.
 *
 * Keyboard: ArrowRight or Enter/Space on the row opens the level and the
 * primitive moves focus into it; ArrowLeft inside the level closes it and the
 * dismissal contract hands focus back to the row. Pointer: hovering the row
 * with a mouse opens it, and leaving both the row and the level closes it
 * after a short grace, so the diagonal path from the row to the panel does
 * not have to be pixel-perfect. Touch and pen get the click only.
 */

/** A lucide icon, or anything with the same two props. */
type Glyph = React.ComponentType<{ size?: number; className?: string }>;

export interface SubmenuItemProps {
  label: string;
  /** The rows of the second level. */
  children: React.ReactNode;
  icon?: Glyph;
  /** What the row says with the level closed: a count, a badge. */
  tail?: React.ReactNode;
  /** `data-testid` on the trigger row. The panel gets `${testId}-menu`. */
  testId?: string;
  /** Accessible name of the level (`aria-label` on its panel). Defaults to `label`. */
  ariaLabel?: string;
  /** Desktop min panel width in px (forwarded to `Menu`, default 180). */
  minWidth?: number;
  /** Extra class names on the level's panel. */
  className?: string;
  /** Extra class names on the trigger row. */
  rowClassName?: string;
}

/**
 * How long the pointer may be outside both the row and the level before the
 * level closes. Long enough to cross the gap diagonally, short enough that
 * moving to a sibling row does not leave a stale level on screen.
 */
const HOVER_GRACE_MS = 150;

export function SubmenuItem({
  label,
  children,
  icon: Icon,
  tail,
  testId,
  ariaLabel,
  minWidth = 180,
  className = '',
  rowClassName = '',
}: SubmenuItemProps) {
  const { isMobile } = useMobile();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, HOVER_GRACE_MS);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);

  // Hover opens with a MOUSE only: a finger that lands on the row is a tap,
  // and a level that opened on touch-down would be a level nobody asked for
  // if the finger was only scrolling past. Touch and pen wait for the click.
  const onPointerEnter = (e: React.PointerEvent) => {
    cancelClose();
    if (e.pointerType === 'mouse') setOpen(true);
  };
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') scheduleClose();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    }
  };

  // The level is a React CHILD of the host panel even though its DOM lives in
  // a portal, so its keydowns bubble up the React tree into the host's
  // `useMenuKeyboard`: an ArrowDown inside the level would ALSO move the
  // host's roving focus. The boundary stops that, and it is where ArrowLeft
  // means "one level up". Escape is not handled here: the dismissal contract
  // listens on the document and already closes the child first.
  const onLevelKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      close();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        // OPEN, never toggle: with a mouse the hover has already opened the
        // level by the time the click lands, and a toggle would close what the
        // user is trying to reach. Closing is the job of the leave grace,
        // ArrowLeft, Escape and the outside press.
        onClick={() => { cancelClose(); setOpen(true); }}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onKeyDown={onTriggerKeyDown}
        className={`${menuRowClass(isMobile)} ${rowClassName}`}
      >
        {Icon && <Icon size={14} className="flex-shrink-0" />}
        <span className="flex-1 text-left">{label}</span>
        {tail}
        <ChevronRight size={14} className="flex-shrink-0 text-app-text-tertiary" />
      </button>
      {/* `display: contents` so the boundary adds no box to the host's rows;
          the panel itself is portalled to <body> by `Menu`. */}
      <span style={{ display: 'contents' }} onKeyDown={onLevelKeyDown}>
        <Menu
          open={open}
          anchorRef={triggerRef}
          onClose={close}
          side="right"
          exclusive={false}
          minWidth={minWidth}
          className={className}
          ariaLabel={ariaLabel ?? label}
          testId={testId ? `${testId}-menu` : undefined}
        >
          <div onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
            {children}
          </div>
        </Menu>
      </span>
    </>
  );
}
