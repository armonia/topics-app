import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';
import { computeMenuPosition } from '@/lib/popoverPosition';
import { useDismissable } from '@/hooks/useDismissable';
import { Spinner } from './Spinner';

/**
 * SuggestionMenu — the dropdown SHELL shared by every "type, see matches, pick
 * one" field: header (icon + label + optional live-query badge + a keyboard
 * hint), a scrollable listbox with loading/empty states, and the ONE dismissal
 * contract every custom menu in the app uses (`useDismissable`: outside
 * pointer + Escape close, the field itself left "inside" so typing in it never
 * closes the menu).
 *
 * Extracted from `FileMentionMenu` (the chat's @-file autocomplete), which had
 * this chrome soldered to file search. The MATCHING — what counts as an item,
 * how it is scored — stays with each caller; this owns only the chrome and the
 * arrow-key scroll behaviour, so a second field (the board's priority/assignee
 * filter, `FilterTokenField`) gets the same look and the same keyboard
 * contract without vendoring file-search logic that has nothing to do with it.
 */
export interface SuggestionMenuProps<T> {
  visible: boolean;
  items: readonly T[];
  getKey: (item: T) => string;
  selectedIndex: number;
  /** Renders one row. The scroll-into-view wrapper is SuggestionMenu's own
   *  (a plain block div around whatever this returns), so the caller's row
   *  never has to hand a ref back up through a render prop. */
  renderItem: (item: T, index: number, ctx: { selected: boolean }) => React.ReactNode;
  /** Dismiss the menu (outside-pointer / Escape). Owned by the parent, which
   *  holds the open flag. */
  onClose?: () => void;
  /** The field that drives this menu — kept "inside" the dismissal so
   *  typing/clicking in it never closes it; the caret is left untouched. */
  inputRef?: React.RefObject<HTMLElement | null>;
  headerIcon?: React.ReactNode;
  headerLabel: string;
  /** Shown next to the label — the live query, e.g. "@foo". */
  filterBadge?: string;
  hint?: string;
  loading?: boolean;
  loadingLabel?: string;
  emptyLabel?: string;
  /** 'above' (default — a chat textarea sits at the bottom of its pane) or
   *  'below' (a filter field sits at the top of the board). */
  position?: 'above' | 'below';
  className?: string;
  /** Extra attributes spread on the root, e.g. `data-mention-menu` — the
   *  legacy hook ChatInput's textarea keydown handler queries by selector. */
  rootAttrs?: Record<string, string | boolean | undefined>;
  /**
   * When given, the panel is PORTALLED to <body> and positioned against this
   * element instead of being absolutely positioned inside it.
   *
   * The board's filter bar needs it: the toolbar is `overflow-x-auto`, and per
   * CSS Overflow 3 any value other than `visible` on one axis computes the
   * OTHER axis to `auto` too - so the bar clips its own children vertically,
   * with the scrollbar switched off. A panel hanging off a 24px shell inside that bar is
   * cut down to nothing.
   *
   * Deliberately NOT `Menu`: under 768px `Menu` becomes a bottom sheet with a
   * full-screen scrim, and the input that DRIVES this list stays up in the
   * toolbar, under that scrim. Touching it to fix your query would close the
   * list. A picker you type into cannot live in a sheet its field is not in.
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** `id` of the inner listbox, so the caller's combobox can `aria-controls` it. */
  listboxId?: string;
  /** Accessible name of the listbox. */
  listboxLabel?: string;
  /** The rows are toggles, not a single choice. */
  multiSelectable?: boolean;
  /** Panel height cap (default `max-h-64`). */
  maxHeightClass?: string;
}

export function SuggestionMenu<T>({
  visible, items, getKey, selectedIndex, renderItem, onClose, inputRef,
  headerIcon, headerLabel, filterBadge, hint, loading, loadingLabel, emptyLabel,
  position = 'above', className, rootAttrs,
  anchorRef, listboxId, listboxLabel, multiSelectable, maxHeightClass,
}: SuggestionMenuProps<T>) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useDismissable({
    open: visible,
    onClose: onClose ?? (() => {}),
    refs: inputRef ? [inputRef, menuRef] : [menuRef],
    restoreFocus: false,
  });

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Placed BEFORE paint, and re-placed while open. No reset when it closes: the
  // next open recomputes in the same layout pass, and `visibility` hides the
  // one frame in which a stale position could show.
  useLayoutEffect(() => {
    if (!visible || !anchorRef) return;
    const place = () => {
      const a = anchorRef.current;
      const panel = menuRef.current;
      if (!a || !panel) return;
      const next = computeMenuPosition(
        a.getBoundingClientRect(),
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { align: 'left' },
      );
      setPos({ top: next.top, left: next.left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [visible, anchorRef]);

  if (!visible) return null;

  const posCls = position === 'above' ? 'bottom-full mb-1' : 'top-full mt-1';
  const cap = maxHeightClass ?? 'max-h-64';

  const panel = (
    <div
      ref={menuRef}
      {...rootAttrs}
      // Anchored mode is a floating panel on <body>: it carries the same
      // `data-popover` marker `Menu` carries, so whoever asks "is the focus in
      // a popover or in a field of the page" gets the same answer here.
      {...(anchorRef ? { 'data-popover': '' } : {})}
      className={
        anchorRef
          ? `fixed ${POPOVER_PANEL} overflow-hidden ${cap} flex flex-col ${className ?? ''}`
          : `absolute ${posCls} left-0 right-0 ${POPOVER_PANEL} z-50 overflow-hidden ${cap} flex flex-col ${className ?? ''}`
      }
      style={
        anchorRef
          ? { top: pos?.top ?? 0, left: pos?.left ?? 0, zIndex: Z_POPOVER, visibility: pos ? 'visible' : 'hidden' }
          : undefined
      }
    >
      <div className="px-3 py-1.5 border-b border-app-border flex items-center gap-2">
        {headerIcon ?? <Search size={12} className="text-app-text-secondary" />}
        <span className="text-[11px] text-app-text-muted font-medium">{headerLabel}</span>
        {filterBadge && <span className="text-[11px] text-primary font-mono">{filterBadge}</span>}
        <div className="flex-1" />
        <span className="text-[11px] text-app-text-muted">{hint ?? '↑↓ navigate · Enter select · Esc close'}</span>
      </div>

      <div
        role="listbox"
        id={listboxId}
        aria-label={listboxLabel}
        aria-multiselectable={multiSelectable || undefined}
        className="overflow-y-auto flex-1"
      >
        {loading ? (
          <div className="px-3 py-4 text-center text-[12px] text-app-text-muted">
            <Spinner size="md" className="mx-auto mb-2" />
            {loadingLabel ?? 'Loading…'}
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-app-text-muted">
            {emptyLabel ?? 'No matches'}
          </div>
        ) : (
          items.map((item, idx) => (
            // A plain block div, not `display:contents`: it is what makes the
            // scroll-into-view ref legal here (a JSX `ref=` attribute owned by
            // THIS component, not threaded back up through `renderItem`'s
            // return value) — and it costs nothing layout-wise, the button
            // `renderItem` returns is already `w-full` block.
            <div key={getKey(item)} ref={(el) => { itemRefs.current[idx] = el; }}>
              {renderItem(item, idx, { selected: idx === selectedIndex })}
            </div>
          ))
        )}
      </div>
    </div>
  );

  return anchorRef ? createPortal(panel, document.body) : panel;
}
