/**
 * Which native browser views this document OPENED and has not closed since, and
 * which of them are being MOVED from one surface to another right now.
 *
 * A PANE THAT CHANGES SURFACE IS A MOVE, NOT AN OPEN. «Open as tab» on a
 * topic's browser window hands the SAME contextId to the layout: the sheet in
 * the window unmounts, a layout pane mounts later. That pane used to call
 * `browser_open` again, and the shell's reuse branch (`browser_open_inner` in
 * lib.rs) NAVIGATES when the url it gets differs from the last url the client
 * asked for: the move reloaded the page (reported 03/10). A mount that finds
 * its view in here ADOPTS it instead (`useTauriBrowser`), with no
 * `browser_open`.
 *
 * WHY THIS RECORD MUST SEE EVERY CLOSE. Adopting a view that is already gone
 * leaves the pane empty until «ricrea». A close does not only come from the
 * hook's deferred cleanup: a real close of a tab also sends `browser_close` at
 * once from the close funnels (`usePanelLifecycle`, `useProjectLayout`,
 * `teardownNativeBrowserPane`), so a reopen inside the hook's 350 ms grace
 * found the id still recorded and adopted a destroyed view. Every close goes
 * through `closeNativeView` or `forgetNativeView` here, so the record is never
 * older than the last close.
 *
 * WHY A MOVE IS A HANDOFF AND NOT A RACE. The arriving pane inside a project
 * is created after a microtask, an await and a Suspense: under load that can
 * take longer than the 350 ms grace, and then the leaving surface's deferred
 * close fired first and the move became close + open, a reload again. The
 * surface that starts a move marks the id (`beginNativeViewMove`); while the
 * mark lives the leaving surface parks its close here instead of queueing it
 * (`deferCloseToMove`), and the arriving mount takes the mark
 * (`takeNativeViewMove`) and adopts. If nobody arrives within
 * `NATIVE_VIEW_MOVE_TIMEOUT_MS` the parked close runs: a move that never lands
 * does not leak a webview.
 *
 * A CLOSE WINS OVER AN OPEN IT OVERTAKES. `browser_open` can still be in flight
 * when a close of the same id runs (the close countdown, an agent's close-pane
 * over the socket, the hook's own deferred close after an unmount). Recording
 * the id when that open answered put back a view the close had just taken out,
 * and a reopen inside the grace adopted it: an empty pane. So every open is
 * registered when it leaves (`beginNativeViewOpen`), a close drops whatever is
 * in flight for its id, and an open that answers after that is not recorded:
 * the view it produced is closed, unless a newer open of the id owns the label
 * by then (`settleNativeViewOpen`).
 *
 * Only this document's own record counts. A view that survived a ⌘R, or that
 * belongs to another window's document, is not in here and still goes through
 * `browser_open`, whose reuse branch is the only one that knows it.
 */

/** The shape of `tauriInvoke` this module needs: command, args, promise. */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** How long a started move waits for its arriving pane before the view is
 *  closed as a normal close would have. Generous on purpose: the arriving pane
 *  is late only under load, and a late close costs one parked webview for a few
 *  seconds, while an early one costs the page. */
export const NATIVE_VIEW_MOVE_TIMEOUT_MS = 10_000;

const openedViews = new Set<string>();

/** One `browser_open` that has left and not answered yet. */
export interface PendingNativeOpen { readonly id: string }
const opensInFlight = new Map<string, Set<PendingNativeOpen>>();

interface PendingMove {
  timer: ReturnType<typeof setTimeout>;
  /** The leaving surface's close, parked until the move lands or expires. */
  parkedClose: (() => void) | null;
}
const pendingMoves = new Map<string, PendingMove>();

/** `browser_open` is leaving for this id. Its answer goes to `settleNativeViewOpen`
 *  when it succeeds and to `dropNativeViewOpen` when it fails. */
export function beginNativeViewOpen(id: string): PendingNativeOpen {
  const open: PendingNativeOpen = { id };
  let pending = opensInFlight.get(id);
  if (!pending) { pending = new Set(); opensInFlight.set(id, pending); }
  pending.add(open);
  return open;
}

/** Take a finished open out of the in-flight set; false when a close took it first. */
function endNativeViewOpen(open: PendingNativeOpen): boolean {
  const pending = opensInFlight.get(open.id);
  if (!pending?.delete(open)) return false;
  if (pending.size === 0) opensInFlight.delete(open.id);
  return true;
}

/**
 * `browser_open` answered. True: the page is live in this document and recorded.
 * False: a close of the id ran while the open was in flight, and the close wins.
 * Nothing is recorded, and the view that just appeared is closed, unless a newer
 * open of the same id owns the label by now (recorded, or still in flight):
 * closing it then would kill that one.
 */
export function settleNativeViewOpen(open: PendingNativeOpen, invoke: Invoke): boolean {
  if (endNativeViewOpen(open)) {
    openedViews.add(open.id);
    return true;
  }
  if (!openedViews.has(open.id) && !opensInFlight.has(open.id)) {
    void closeNativeView(open.id, invoke).catch(() => {});
  }
  return false;
}

/** `browser_open` failed: no view came of it, nothing to record or close. */
export function dropNativeViewOpen(open: PendingNativeOpen): void {
  endNativeViewOpen(open);
}

/** Whether a mount for this id may adopt a live view instead of opening one. */
export function isNativeViewOpened(id: string): boolean {
  return openedViews.has(id);
}

/** The view is gone (or about to be): forget it, any move it was in, and any
 *  open still in flight for it, which has lost to this close. */
export function forgetNativeView(id: string): void {
  openedViews.delete(id);
  opensInFlight.delete(id);
  const move = pendingMoves.get(id);
  if (move) { clearTimeout(move.timer); pendingMoves.delete(id); }
}

/** Close a native view and forget it was open, so the next mount OPENS. */
export function closeNativeView(id: string, invoke: Invoke): Promise<unknown> {
  forgetNativeView(id);
  return invoke('browser_close', { id });
}

/**
 * The page under `id` is about to change surface. Until a mount takes the mark
 * (or it expires) the surface that lets go of the view does not close it.
 */
export function beginNativeViewMove(id: string): void {
  const previous = pendingMoves.get(id);
  if (previous) clearTimeout(previous.timer);
  const move: PendingMove = {
    parkedClose: previous?.parkedClose ?? null,
    timer: setTimeout(() => {
      if (pendingMoves.get(id) !== move) return;
      pendingMoves.delete(id);
      move.parkedClose?.();
    }, NATIVE_VIEW_MOVE_TIMEOUT_MS),
  };
  pendingMoves.set(id, move);
}

/** The move did not happen (nobody hosted the page): drop the mark, close nothing. */
export function cancelNativeViewMove(id: string): void {
  const move = pendingMoves.get(id);
  if (!move) return;
  clearTimeout(move.timer);
  pendingMoves.delete(id);
}

/**
 * The arriving surface mounts: true when a move was waiting for it. The mark
 * and any parked close are dropped, the view now belongs to this mount.
 */
export function takeNativeViewMove(id: string): boolean {
  const move = pendingMoves.get(id);
  if (!move) return false;
  clearTimeout(move.timer);
  pendingMoves.delete(id);
  return true;
}

/**
 * The leaving surface lets go of the view. Inside a move its close is parked
 * (runs only if the move expires) and this returns true; otherwise false, and
 * the caller closes as usual.
 */
export function deferCloseToMove(id: string, close: () => void): boolean {
  const move = pendingMoves.get(id);
  if (!move) return false;
  move.parkedClose = close;
  return true;
}

/** Ids whose view is held by nobody while a move waits for its pane: a bundle
 *  reload must close them too, nobody would after it. */
export function movingNativeViews(): string[] {
  return [...pendingMoves.keys()];
}
