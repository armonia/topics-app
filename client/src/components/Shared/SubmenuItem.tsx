import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Menu } from './Menu';
import { useMobile } from '../../hooks/useMobile';
import { menuRowClass } from '../Sidebar/menuRow';
import { isTypingSurface } from '../../hooks/useMenuKeyboard';
import { LevelCloseContext } from './levelClose';

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
 *   - the portal, the glass surface, `role="menu"` (`dialog` for a form level;
 *     either lifts it over a native browser pane), the mobile bottom sheet and the z layer.
 *
 * Keyboard: ArrowRight or Enter/Space on the row opens the level and the
 * primitive moves focus into it; ArrowLeft inside the level closes it and the
 * dismissal contract hands focus back to the row. Pointer: hovering the row
 * with a mouse opens it, and leaving both the row and the level closes it
 * after a short grace, so the diagonal path from the row to the panel does
 * not have to be pixel-perfect. Touch and pen get the click only.
 *
 * A CLICK PINS THE LEVEL. Hover-open and hover-close is right for a level you
 * are passing through; it is wrong for one you went to READ (the performance
 * numbers, the version, an agent list that updates while you watch): the
 * pointer drifting one row away took the panel with it. So a level opened by
 * an explicit gesture (click, ArrowRight) stays until something explicit
 * closes it: Escape, a press outside, or another level opening at the same
 * depth. A level opened by hover alone still closes on hover-out.
 *
 * USING A LEVEL PINS IT TOO. A press or a key inside a level opened by hover
 * is the same decision as the click on its row: the level now holds a form
 * half filled, or has asked a question. Left unpinned, the pointer drifting
 * off it threw the typed key away, and a confirmation (portalled outside the
 * level's React tree, so moving onto it is a `pointerleave`) closed the level
 * before it could be answered.
 *
 * ONE LEVEL PER DEPTH. Pinning without this rule leaves two panels side by
 * side, both claiming to belong to the same host. Every level provides its own
 * registry to whatever it contains, so "siblings" means the rows of ONE panel
 * and a nested level never evicts the level it opened from.
 */

/** The open level among the rows of ONE panel: opening a sibling closes it.
 *  An API and not a mutable field, because a value handed out by a context is
 *  read-only by contract (and the compiler enforces it): the state lives in
 *  the closure, the rows only claim and release it. */
interface SiblingSlot {
  claim: (token: object, close: () => void) => void;
  release: (token: object) => void;
}

function createSiblingSlot(): SiblingSlot {
  let owner: object | null = null;
  let closeOwner: (() => void) | null = null;
  return {
    claim(token, close) {
      if (owner && owner !== token) closeOwner?.();
      owner = token;
      closeOwner = close;
    },
    release(token) {
      if (owner === token) {
        owner = null;
        closeOwner = null;
      }
    },
  };
}

const SiblingContext = createContext<SiblingSlot>(createSiblingSlot());

/**
 * HOW WIDE THE PANEL THIS ROW LIVES IN IS, so its own level can be at least as
 * wide.
 *
 * Without it every call site wrote its own `minWidth` by hand - 244, 230, 312,
 * 300, 260 - and while the host was a constant too, nobody could see the
 * staircase. Now that the user menu is as wide as the column (which drags
 * between 180 and 400) a host can be 400 while its levels stay at 230: a
 * ragged staircase, caused by nothing anyone could read in one place. The
 * number at the call site survives, as a FLOOR: the wider of it and the host
 * wins.
 *
 * Every level republishes its own width to its children, so a third level
 * inherits from the second and not from the first.
 */
const HostWidthContext = createContext<number>(0);

/** For whoever owns a panel of known width (the user menu, which measures the
 *  card that opens it) to hand that measure down to every level it contains,
 *  at any depth. */
export function MenuWidthProvider({ width, children }: { width: number; children: React.ReactNode }) {
  return <HostWidthContext.Provider value={width}>{children}</HostWidthContext.Provider>;
}

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
  /** Desktop max panel width in px (forwarded to `Menu`), and a ceiling on the
   *  host-width floor below. Two shapes need it: a level of fixed `label ·
   *  value` rows, which a wide sidebar column would stretch apart, and a level
   *  whose content can be one long line, which would otherwise grow to that
   *  line instead of wrapping it. */
  maxWidth?: number;
  /** Extra class names on the level's panel. */
  className?: string;
  /** Extra class names on the trigger row. */
  rowClassName?: string;
  /** Told whenever the level opens or closes: for a host that has to suppress
   *  something else while it is up (the updater toast, over the version). */
  onOpenChange?: (open: boolean) => void;
  /** Open, and pinned, right after mounting: as if it had been clicked. For a
   *  host asked to land on this level (`lib/openUserMenu`). */
  defaultOpen?: boolean;
  /** The level's role. 'dialog' for a level that holds a FORM: a text field
   *  inside role=menu is announced as a menu item and has no business there.
   *  The panel keeps `Menu`'s keyboard and dismissal either way. */
  levelRole?: 'menu' | 'dialog';
}

/**
 * How long the pointer may be outside both the row and the level before the
 * level closes. Long enough to cross the gap diagonally, short enough that
 * moving to a sibling row does not leave a stale level on screen.
 */
const HOVER_GRACE_MS = 150;

/**
 * How long the pointer must REST on the row before hover alone opens the
 * level. Without it every row the mouse crosses on its way somewhere else
 * opens a panel and closes it again, which is a menu that flickers while you
 * are only travelling through it; and it made the open depend on a race
 * between the hover and the click that follows it. A click never waits.
 */
const HOVER_OPEN_MS = 120;

export function SubmenuItem({
  label,
  children,
  icon: Icon,
  tail,
  testId,
  ariaLabel,
  minWidth = 180,
  maxWidth,
  className = '',
  rowClassName = '',
  onOpenChange,
  defaultOpen = false,
  levelRole = 'menu',
}: SubmenuItemProps) {
  const { isMobile } = useMobile();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Opened on purpose, so hover-out must not take it away.
  const pinned = useRef(false);
  const siblings = useContext(SiblingContext);
  // The call site's number is a FLOOR, not the measure: the wider of it and
  // the host's width wins. See `HostWidthContext`.
  const hostWidth = useContext(HostWidthContext);
  const levelWidth = maxWidth
    ? Math.min(Math.max(minWidth, hostWidth), maxWidth)
    : Math.max(minWidth, hostWidth);
  // Who this row is, for the slot it competes in: an identity, created once.
  const token = useMemo(() => ({}), []);
  // The slot THIS level hands to its own rows, so a nested level registers
  // with its host and not with its host's host.
  const nested = useMemo(() => createSiblingSlot(), []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const cancelHoverOpen = useCallback(() => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  const close = useCallback(() => {
    cancelClose();
    cancelHoverOpen();
    pinned.current = false;
    siblings.release(token);
    setOpen(false);
  }, [cancelClose, cancelHoverOpen, siblings, token]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!pinned.current) close();
    }, HOVER_GRACE_MS);
  }, [cancelClose, close]);

  const openLevel = useCallback((pin: boolean) => {
    cancelClose();
    cancelHoverOpen();
    if (pin) pinned.current = true;
    siblings.claim(token, close);
    setOpen(true);
  }, [cancelClose, cancelHoverOpen, close, siblings, token]);

  useEffect(() => () => {
    cancelClose();
    cancelHoverOpen();
    siblings.release(token);
  }, [cancelClose, cancelHoverOpen, siblings, token]);

  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  // A level asked for on mount opens one task later, as a click would: the
  // host panel registers as an open popover in the same commit, and a level
  // registered BEFORE it would be evicted by the host's "one at a time" rule.
  useEffect(() => {
    if (!defaultOpen) return;
    const timer = setTimeout(() => openLevel(true), 0);
    return () => clearTimeout(timer);
  }, [defaultOpen, openLevel]);

  // Hover opens with a MOUSE only: a finger that lands on the row is a tap,
  // and a level that opened on touch-down would be a level nobody asked for
  // if the finger was only scrolling past. Touch and pen wait for the click.
  const onPointerEnter = (e: React.PointerEvent) => {
    cancelClose();
    if (e.pointerType !== 'mouse') return;
    if (open) return;
    cancelHoverOpen();
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      openLevel(false);
    }, HOVER_OPEN_MS);
  };
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    cancelHoverOpen();
    scheduleClose();
  };

  // See «using a level pins it too» above.
  const pin = () => { pinned.current = true; };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      openLevel(true);
    }
  };

  // The level is a React CHILD of the host panel even though its DOM lives in
  // a portal, so its keydowns bubble up the React tree into the host's
  // `useMenuKeyboard`: an ArrowDown inside the level would ALSO move the
  // host's roving focus. The boundary stops that, and it is where ArrowLeft
  // means "one level up". Escape is not handled here: the dismissal contract
  // listens on the document and already closes the child first.
  //
  // NOT FROM A FIELD. A level can hold a form (an API key, a URL): there the
  // left arrow moves the caret, and closing the level under it would throw the
  // half-typed value away.
  const onLevelKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    pinned.current = true;
    if (e.key === 'ArrowLeft' && !isTypingSurface(e.target)) {
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
        aria-haspopup={levelRole}
        aria-expanded={open}
        data-testid={testId}
        // OPEN, never toggle: with a mouse the hover has already opened the
        // level by the time the click lands, and a toggle would close what the
        // user is trying to reach. Closing is the job of the leave grace,
        // ArrowLeft, Escape and the outside press.
        onClick={() => openLevel(true)}
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
          role={levelRole}
          exclusive={false}
          minWidth={levelWidth}
          maxWidth={maxWidth}
          className={className}
          ariaLabel={ariaLabel ?? label}
          testId={testId ? `${testId}-menu` : undefined}
        >
          <div onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onPointerDown={pin}>
            <SiblingContext.Provider value={nested}>
              <LevelCloseContext.Provider value={close}>
                <HostWidthContext.Provider value={levelWidth}>{children}</HostWidthContext.Provider>
              </LevelCloseContext.Provider>
            </SiblingContext.Provider>
          </div>
        </Menu>
      </span>
    </>
  );
}
