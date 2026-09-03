import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { TAB_LABEL } from '../../lib/selectionStyles';
import { pinnedLabelShown } from './pinnedTileMetrics';

/**
 * The two halves of ONE measurement, kept together: the hook reads the tile
 * and the name, the box below is what it reads the name from. `PinnedTile`
 * mounts both and only draws the verdict.
 */

/**
 * DOES THE NAME FIT? Two widths, read from the DOM: the tile's, which changes
 * with the sidebar and with how many tiles share the row, and the name's
 * FULL width, from a 0x0 measuring box that overflows with the text
 * (`scrollWidth` reports the overflow, and a box with no size paints
 * nothing and can never be found outside the tile). The verdict is
 * `pinnedLabelShown`, the pure rule in `pinnedTileMetrics`.
 *
 * `useLayoutEffect` and not `useEffect`: the first reading lands before the
 * first paint, so a name that will not fit is never seen for a frame. The
 * observer covers everything after that (a drag that packs the row, a
 * sidebar resize). Until the first reading (`null`) the class list falls
 * back to the container-query thresholds, which is what the tile did before.
 */
export function usePinnedLabelFit({ isRow, name, hasIcon, expandable }: {
  /** Row form asks nothing: the tile is a row and the name truncates. */
  isRow: boolean;
  name: string;
  hasIcon: boolean;
  expandable: boolean;
}): {
  tileRef: RefObject<HTMLButtonElement | null>;
  measureRef: RefObject<HTMLSpanElement | null>;
  /** `null` until the first reading; then the verdict of `pinnedLabelShown`. */
  labelShown: boolean | null;
} {
  const tileRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ tile: number; label: number } | null>(null);
  useLayoutEffect(() => {
    if (isRow) return;
    const tile = tileRef.current;
    if (!tile) return;
    const read = () => {
      const width = tile.getBoundingClientRect().width;
      const label = measureRef.current?.scrollWidth ?? 0;
      setFit((prev) => (prev && prev.tile === width && prev.label === label ? prev : { tile: width, label }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(tile);
    return () => ro.disconnect();
  }, [isRow, name]);
  const labelShown = fit === null
    ? null
    : pinnedLabelShown({ tileWidth: fit.tile, labelWidth: fit.label, hasIcon, expandable });
  return { tileRef, measureRef, labelShown };
}

/**
 * THE MEASURING BOX: the whole name, in the tile's font, in a box of no
 * size. `scrollWidth` reads the overflow, i.e. the width the name would
 * take untruncated, and the box itself paints nothing and occupies
 * nothing, so no test that walks the tile's descendants can find it
 * outside the tile. Only in grid form, where the question is asked.
 */
export function PinnedLabelMeasure({ measureRef, name }: { measureRef: RefObject<HTMLSpanElement | null>; name: string }) {
  return (
    <span
      ref={measureRef}
      aria-hidden="true"
      data-testid="pinned-tile-measure"
      className={`pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden whitespace-nowrap ${TAB_LABEL}`}
    >
      {name}
    </span>
  );
}
