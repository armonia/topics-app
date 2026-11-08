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

/** The slice of `window` the watcher needs, structural so a test can pass a
 *  plain `EventTarget` (this project has no DOM in its unit tests). */
export interface DragEndSource {
  addEventListener(type: string, listener: (e: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (e: Event) => void, capture?: boolean): void;
}

/**
 * Calls `onEnd` as soon as the drag that lit the "drop files here" frame is
 * over, wherever it ended. Returns the detach.
 *
 * The transcript's own dragleave and drop only see a drag that ends ON it.
 * Released on the composer or on another pane, released off the window, or
 * cancelled with Esc, the drag never told it: WKWebView (the Tauri shell) gives
 * dragleave no relatedTarget, so a pointer still inside the transcript's rect
 * read as "still here", and the frame stayed up for good (topic:64095902,
 * 07/10). The proof that the gesture is over is the layout's (GroupLayout): a
 * drop or dragend anywhere in the window, and, since HTML5 DnD holds back
 * pointer events for the whole gesture, the first pointerup, the first
 * pointermove with no button held, or the window losing focus.
 */
export function watchFileDragEnd(source: DragEndSource, onEnd: () => void): () => void {
  const end = () => onEnd();
  const onMove = (e: Event) => { if (((e as PointerEvent).buttons & 1) === 0) onEnd(); };
  // Capture: a drop zone that stops the drop must not hide it from us.
  const terminal = ['drop', 'dragend', 'pointerup'];
  for (const type of terminal) source.addEventListener(type, end, true);
  source.addEventListener('pointermove', onMove, true);
  source.addEventListener('blur', end);
  return () => {
    for (const type of terminal) source.removeEventListener(type, end, true);
    source.removeEventListener('pointermove', onMove, true);
    source.removeEventListener('blur', end);
  };
}
