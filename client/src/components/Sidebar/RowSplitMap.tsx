import { SplitMiniMap } from '@/components/Shared/SplitMiniMap';
import { useSplitPosition } from '@/contexts/SplitPositionContext';
import { ON_FILL_TEXT_SOFT } from '@/lib/selectionStyles';

/**
 * WHERE THIS ROW'S PANE SITS IN THE SPLIT, and the SAME answer on every row.
 *
 * The schematic already existed, and that was the problem: three copies of it
 * lived in three row bodies (chat, terminal, project), so the sidebar answered
 * "where is this pane" for three row families and stayed mute for the other
 * three. Measured before this file: a browser open in a split cell, a utility
 * pane and the board row carried no map at all, and the project row's copy had
 * drifted to its own trailing margin (`mr-1.5`) that the sisters did not have.
 * A signal that appears or vanishes with the TYPE of the row is worse than one
 * that is never there: the eye reads the absence as "this one is not in the
 * split".
 *
 * So the decision is taken once, here, and every row calls it with the pane id
 * it stands for. There is nothing to configure: with no split published for
 * that id the component renders nothing, which is what "only when there is
 * something to orient against" means.
 *
 * It is a COMPONENT and not a hook call at the call site because
 * `useSplitPosition` is a hook: the project and utility rows are drawn inside
 * render loops, where a hook cannot go.
 */
export function RowSplitMap({ paneId, onFill }: { paneId: string | undefined | null; onFill?: boolean }) {
  const pos = useSplitPosition(paneId);
  if (!pos) return null;
  return (
    <SplitMiniMap
      rows={pos.rows}
      rowHeights={pos.rowHeights}
      active={pos.active}
      // The map draws from `currentColor`: on an attention fill it MUST inherit
      // the fill's high-contrast tone instead of a fixed grey, which is the
      // grey-on-blue defect the chat row already fixed once.
      className={`flex-shrink-0 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
    />
  );
}
