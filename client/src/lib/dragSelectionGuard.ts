/**
 * NO TEXT SELECTION WHILE A RAW POINTER DRAG IS IN FLIGHT.
 *
 * A drag built on `pointerdown` + window `pointermove` (the floating browser
 * window's bar, its dock edge, the responsive-size handle) does not stop the
 * engine's own default for a pressed, moving mouse: a text selection anchored
 * where the press landed and extended to wherever the pointer is. The dragged
 * surface follows the pointer one render late, so a fast hand gets ahead of it
 * and the selection runs from the window (portaled at the end of the body)
 * across the whole transcript under it. Reported 30/09, "mentre faccio dnd di
 * un tab browser floating, mi seleziona il testo del topic sotto".
 *
 * HTML5 drags (tabs, pinned tiles) and dnd-kit (board cards) are not affected:
 * the native drag session selects nothing, and dnd-kit clears the selection on
 * activation. Dividers cancel their `mousedown`, which is what starts a
 * selection, so they do not need this either.
 *
 * Three layers, because each one alone has a hole:
 *  - a class on `<html>` that makes everything `user-select: none` (index.css),
 *    so the selection cannot grow even if the engine already anchored one;
 *  - `selectstart` cancelled, because the class is applied inside the
 *    `pointerdown` handler and the engine may decide on the `mousedown` that
 *    follows with the style it had before;
 *  - any selection there is at the start is dropped, as a native press on a
 *    non-text surface would do anyway.
 *
 * It lets go by itself on every door a gesture can end through: `pointerup`,
 * `mouseup`, `pointercancel`, window `blur`, Escape, and the first `pointermove`
 * with no button held (a release the page never saw, e.g. over a native view).
 * The owner releases it too, on its own drop and on unmount; a release is
 * idempotent, and a stale one can never end a newer drag's hold.
 *
 * Seams are injectable so this is testable without a DOM (no jsdom/happy-dom in
 * this project, see `Board/ThreadRuns.test.tsx`).
 */

export const DRAG_NO_SELECT_CLASS = 'drag-no-select';

interface ListenerTarget {
  addEventListener(type: string, fn: (e: Event) => void, options?: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, options?: boolean): void;
}

export interface DragSelectionEnv {
  /** Where the class goes. Defaults to `document.documentElement`. */
  root: { classList: { add(c: string): void; remove(c: string): void } };
  /** Where the end-of-gesture doors are heard. Defaults to `window`. */
  target: ListenerTarget;
  /** Drops the current selection. Defaults to `getSelection().removeAllRanges()`. */
  clearSelection(): void;
}

function browserEnv(): DragSelectionEnv {
  return {
    root: document.documentElement,
    target: window as unknown as ListenerTarget,
    clearSelection: () => { window.getSelection()?.removeAllRanges(); },
  };
}

/** The holds currently in force. Empty = no guard on the page. */
const holds = new Set<symbol>();
let disengage: (() => void) | null = null;

function engage(env: DragSelectionEnv): () => void {
  env.root.classList.add(DRAG_NO_SELECT_CLASS);
  env.clearSelection();
  const cancel = (e: Event): void => { e.preventDefault(); };
  const end = (): void => { releaseAll(); };
  const onKey = (e: Event): void => { if ((e as KeyboardEvent).key === 'Escape') releaseAll(); };
  const onMove = (e: Event): void => { if (((e as PointerEvent).buttons & 1) === 0) releaseAll(); };
  const t = env.target;
  t.addEventListener('selectstart', cancel, true);
  t.addEventListener('pointerup', end, true);
  t.addEventListener('mouseup', end, true);
  t.addEventListener('pointercancel', end, true);
  t.addEventListener('blur', end);
  t.addEventListener('keydown', onKey, true);
  t.addEventListener('pointermove', onMove, true);
  return () => {
    env.root.classList.remove(DRAG_NO_SELECT_CLASS);
    t.removeEventListener('selectstart', cancel, true);
    t.removeEventListener('pointerup', end, true);
    t.removeEventListener('mouseup', end, true);
    t.removeEventListener('pointercancel', end, true);
    t.removeEventListener('blur', end);
    t.removeEventListener('keydown', onKey, true);
    t.removeEventListener('pointermove', onMove, true);
  };
}

function releaseAll(): void {
  holds.clear();
  const off = disengage;
  disengage = null;
  off?.();
}

/**
 * Hold the document selection-free from now until the gesture ends. Call it
 * from the `pointerdown` that may become a drag, BEFORE the engine's default
 * action runs. Returns the release; calling it more than once is harmless.
 */
export function suppressTextSelection(env?: DragSelectionEnv): () => void {
  const token = Symbol('drag');
  holds.add(token);
  if (!disengage) disengage = engage(env ?? browserEnv());
  return () => {
    if (!holds.delete(token)) return;
    if (holds.size === 0) releaseAll();
  };
}
