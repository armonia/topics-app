import { isInternalDrag } from '../../lib/dndTypes';

/**
 * May the chat body claim this drag as a file (or text) drop?
 *
 * Only for what comes from OUTSIDE the app. The old test was "no PANEL_ID", but
 * only top-level tabs carry PANEL_ID: a PROJECT tab dragged over a chat lit the
 * "drop files here" frame, and the handler's stopPropagation hid the dragover
 * from the layout around it, so the pane's split bands died over the message
 * list and the release did nothing. Every drag this app starts belongs to the
 * layout's own drop zones.
 */
export function chatAcceptsFileDrag(types: readonly string[]): boolean {
  return !isInternalDrag(types);
}
