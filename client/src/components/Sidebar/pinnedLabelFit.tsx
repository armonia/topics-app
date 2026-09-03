import type { RefObject } from 'react';
import { TAB_LABEL } from '../../lib/selectionStyles';

/**
 * The other half of the measurement of `usePinnedLabelFit.ts`: the box the
 * hook reads the name from. Kept in its own .tsx so the file exports only a
 * component (fast refresh).
 */

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
