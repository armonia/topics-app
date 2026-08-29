/**
 * THE GESTURE THAT NEVER ENDED, AND THE PAGE THAT NEVER CAME BACK.
 *
 * A native browser pane parks its WebContentsView at `{0,0,0,0}` while any
 * drag is in flight: the OS-level view composites ABOVE the DOM, so as long as
 * it is on screen it eats the `dragover`/`drop` of every React drop target it
 * covers. The counter that decides "a drag is in flight" is the whole safety of
 * that trick: while it reads above zero the pane shows NOTHING.
 *
 * Which is why it cannot be driven by `dragend`/`drop` alone. Those two are not
 * guaranteed: in the WKWebView of the Tauri shell a release captured by a
 * native view, or a drag that ends off-window, drops both. One increment with
 * no decrement and the browser pane stays blank until the next gesture happens
 * to over-decrement it back to zero. "The page disappears until I drag again".
 *
 * So the release has THREE more doors, the same belt `paneDragFlag` and
 * `GroupLayout` already wear: a window `blur`, any `pointerup`, and the first
 * `pointermove` with no button held. HTML5 drag-and-drop suppresses pointer
 * events for the DURATION of the gesture, so a pointer event with the button
 * up is proof that the gesture is over, whatever the drag events did or did not
 * say.
 *
 * A belt release zeroes the counter instead of decrementing it: after a lost
 * `dragend` the count is wrong by an unknown amount, and the only number that
 * is certainly right once the pointer is up is zero.
 *
 * Every seam is injectable so this is testable without a DOM: this project has
 * no jsdom/happy-dom dependency (a declared choice, see `Board/ThreadRuns.test.tsx`).
 */

/** The slice of `window` this gate needs. Kept structural so a test can pass a
 *  bare recorder instead of a real event target. */
export interface DragGateTarget {
  addEventListener(type: string, fn: (e: Event) => void, options?: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, options?: boolean): void;
}

export interface NativeViewDragGateOptions {
  /** A gesture started: park the native view (called once per 0 -> 1 edge). */
  onOcclude(): void;
  /** Every gesture is over: give the pane back (called once per N -> 0 edge). */
  onRelease(): void;
  /** Defaults to `window`. */
  target?: DragGateTarget;
}

/** Gestures that hide the view. `topics:pane-resize-*` is here because a divider
 *  resize is a raw pointer drag and never fires `dragstart`: without it the view
 *  stays on top and swallows the pointer the moment it crosses a browser pane. */
const START_EVENTS = ['dragstart', 'topics:pane-resize-start'] as const;
/** The nominal ends. Not guaranteed, hence the belt below. */
const END_EVENTS = ['dragend', 'drop', 'topics:pane-resize-end'] as const;

/**
 * Arm the gate. Returns the disposer: it detaches every listener in one call,
 * so an effect cleanup cannot half-detach.
 */
export function installNativeViewDragGate(opts: NativeViewDragGateOptions): () => void {
  const target = opts.target ?? (window as unknown as DragGateTarget);
  let count = 0;

  const onStart = (): void => {
    count += 1;
    if (count === 1) opts.onOcclude();
  };
  const onEnd = (): void => {
    if (count === 0) return;
    count -= 1;
    if (count === 0) opts.onRelease();
  };
  /** The belt: the gesture is over, whatever the counter believes. */
  const forceEnd = (): void => {
    if (count === 0) return;
    count = 0;
    opts.onRelease();
  };
  const onPointerMove = (e: Event): void => {
    // A pointer moving with no primary button held cannot be a drag. During a
    // real HTML5 drag this handler is never reached (pointer events are
    // suppressed), so reading it as "finished" is safe, not a guess.
    if (((e as PointerEvent).buttons & 1) === 0) forceEnd();
  };

  for (const type of START_EVENTS) target.addEventListener(type, onStart, true);
  for (const type of END_EVENTS) target.addEventListener(type, onEnd, true);
  target.addEventListener('pointerup', forceEnd, true);
  target.addEventListener('pointermove', onPointerMove, true);
  target.addEventListener('blur', forceEnd);

  return () => {
    for (const type of START_EVENTS) target.removeEventListener(type, onStart, true);
    for (const type of END_EVENTS) target.removeEventListener(type, onEnd, true);
    target.removeEventListener('pointerup', forceEnd, true);
    target.removeEventListener('pointermove', onPointerMove, true);
    target.removeEventListener('blur', forceEnd);
  };
}
