/**
 * THE ROOM UNDER THE LAST CARD OF A COLUMN, measured instead of guessed.
 *
 * Asked on 05/10 (KANBAN-MOBILE-04): «pur poi scrollando, alla fine l'ultima
 * card dovrebbe preservare lo spazio sotto». The column body used to reserve a
 * fixed `pb-36` (144px) for the floating composer that sits over the bottom of
 * the board. On a 390x844 phone the band that composer and the button row cover
 * was 141px, so a column scrolled to its end parked its last card 3px above the
 * composer: technically visible, visually glued to it. Any growth of the band
 * (the notice band above the buttons, a composer opened on two lines, attached
 * files) put the card behind the box it was written in.
 *
 * So the board measures the covered band - how far the composer's top edge
 * reaches into the scroller - and publishes it plus a fixed breath as
 * `BOARD_BOTTOM_CLEAR_VAR`. The column body spends it as its bottom padding;
 * CSS takes the max with the phone's button band, which covers the bottom
 * whenever the composer is hidden.
 */
import { useLayoutEffect, type RefObject } from 'react';

/** The CSS variable the columns row carries and every column body reads. */
export const BOARD_BOTTOM_CLEAR_VAR = '--board-bottom-clear';

/** The breath between the last card and whatever floats below it. */
export const CLEARANCE_GAP_PX = 16;

/**
 * The bottom padding a scroller needs so its last item ends `gap` above the
 * cover. `coverTop` is null when nothing covers the bottom (composer hidden):
 * then the gap alone, and CSS adds the phone's button band on its own.
 */
export function bottomClearance(scrollerBottom: number, coverTop: number | null, gap: number = CLEARANCE_GAP_PX): number {
  const covered = coverTop == null ? 0 : Math.max(0, scrollerBottom - coverTop);
  return Math.ceil(covered + gap);
}

/**
 * Keeps the clearance of the columns in `rowRef` in sync with the composer
 * that floats over them, written straight on the row as
 * `BOARD_BOTTOM_CLEAR_VAR`: a resize repaints the padding without rendering
 * the board again. The composer is found next to the row, inside the same
 * board area, so two boards on screen never read each other's composer.
 * Before the first measure the CSS fallback holds. `mounted` is false while
 * the board still shows its loading ring: the row does not exist yet, and the
 * effect has to run again the moment it does.
 */
export function useColumnClearance(rowRef: RefObject<HTMLElement | null>, layout: 'grid' | 'list', mounted: boolean): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    const area = row?.parentElement;
    if (!row || !area) return;
    const measure = () => {
      // In the grid every column body scrolls on its own and they share one
      // bottom edge; in the list the row itself is the scroller.
      const scroller = layout === 'grid'
        ? row.querySelector<HTMLElement>('[data-testid^="kanban-column-body-"]')
        : row;
      if (!scroller) return;
      const composer = area.querySelector<HTMLElement>('[data-testid="board-task-composer"]');
      const rect = composer?.getBoundingClientRect();
      const coverTop = rect && rect.height > 0 ? rect.top : null;
      const next = `${bottomClearance(scroller.getBoundingClientRect().bottom, coverTop)}px`;
      if (row.style.getPropertyValue(BOARD_BOTTOM_CLEAR_VAR) !== next) row.style.setProperty(BOARD_BOTTOM_CLEAR_VAR, next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    const composer = area.querySelector<HTMLElement>('[data-testid="board-task-composer"]');
    if (composer) ro.observe(composer);
    // The composer also MOVES without resizing: the button band under it comes
    // and goes with the keyboard, and the visual viewport shifts it.
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [rowRef, layout, mounted]);
}
