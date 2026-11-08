import { isInternalDrag } from '../../lib/dndTypes';

/**
 * Is this drag the file tree's business?
 *
 * Its own rows being moved (`ownPathsInFlight`), and what comes from outside the
 * app (files from the Finder, text). Not the drags the app itself starts: a pane
 * tab crossing the Files pane is aimed at the layout's split bands, and the rows
 * used to take it, flashing the folder under the pointer and stopping the drop
 * before the layout could see it.
 */
export function fileTreeClaimsDrag(types: readonly string[], ownPathsInFlight: boolean): boolean {
  return ownPathsInFlight || !isInternalDrag(types);
}
