/**
 * Does the Topics window this document draws have the focus?
 *
 * WHY NOT `document.hasFocus()`. A native browser pane is a sibling webview of
 * this document, so the moment the user clicks into a page this document loses
 * focus to its own pane: the answer is inverted exactly when a pane is in use
 * (see the note on `INSTALL_FOCUS_HOOK` in `useTauriBrowser`). The shell knows the
 * window's real key/foreground state and tells the page with a
 * `topics:window-focus` event (`desktop-tauri/src-tauri/src/window_focus.rs`).
 *
 * THREE VALUES, and `null` counts as focused. `null` is "nobody has answered":
 * before the first event, on an older shell without the command, on Linux. The
 * only way to `false` is an event or a correct platform answer, so a shell that
 * says nothing never pauses a pane or silences a poll.
 *
 * AN EVENT BEATS A QUERY that was sent before it. A page that (re)loads asks
 * `window_focus_state` once; if a focus event lands while that answer is in
 * flight, the answer describes an older moment and is dropped.
 */
import { tauriInvoke } from './tauri';
import { DEFAULT_POLL_ENV, type PollEnv } from './visibilityPoll';

export type WindowFocus = boolean | null;

export interface WindowFocusStore {
  get(): WindowFocus;
  /** Called with (previous, next) on every change. Returns the unsubscribe. */
  subscribe(fn: (prev: WindowFocus, next: WindowFocus) => void): () => void;
  /** A `topics:window-focus` event from the shell. */
  noteEvent(focused: boolean): void;
  /** Ask the shell once. Resolves when the answer was applied or discarded. */
  query(ask: () => Promise<unknown>): Promise<void>;
}

export function createWindowFocusStore(): WindowFocusStore {
  let value: WindowFocus = null;
  let events = 0;
  const listeners = new Set<(prev: WindowFocus, next: WindowFocus) => void>();
  const set = (next: WindowFocus): void => {
    if (next === value) return;
    const prev = value;
    value = next;
    for (const fn of [...listeners]) fn(prev, next);
  };
  return {
    get: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    noteEvent(focused) {
      events += 1;
      set(focused);
    },
    async query(ask) {
      const sentAfter = events;
      let answer: unknown;
      try {
        answer = await ask();
      } catch {
        return; // a shell without the command: stays unknown
      }
      if (events !== sentAfter || typeof answer !== 'boolean') return;
      set(answer);
    },
  };
}

/** The store of THIS document, wired to the shell on first use. */
const store = createWindowFocusStore();
let wired = false;

function wire(): void {
  if (wired || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  wired = true;
  window.addEventListener('topics:window-focus', (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (typeof detail === 'boolean') store.noteEvent(detail);
  });
  void store.query(() => tauriInvoke<boolean | null>('window_focus_state'));
}

export function windowFocused(): WindowFocus {
  wire();
  return store.get();
}

export function subscribeWindowFocus(fn: (prev: WindowFocus, next: WindowFocus) => void): () => void {
  wire();
  return store.subscribe(fn);
}

/** A focus event from outside the shell listener. Used by the hook benches. */
export function noteWindowFocusEvent(focused: boolean): void {
  store.noteEvent(focused);
}

/**
 * The poll environment of one native pane: the document is visible, the window
 * is not known to be unfocused, and the pane wants this poll right now.
 *
 * `onVisible` fires on each reopening edge of any of the three gates; the poll
 * re-checks `isVisible` before its catch-up tick, so an edge that fires while
 * another gate is still closed does nothing.
 */
export function panePollEnv(opts: {
  wanted: () => boolean;
  onWanted: (fn: () => void) => () => void;
  focus?: Pick<WindowFocusStore, 'get' | 'subscribe'>;
  base?: PollEnv;
}): PollEnv {
  const base = opts.base ?? DEFAULT_POLL_ENV;
  const focus = opts.focus ?? { get: windowFocused, subscribe: subscribeWindowFocus };
  return {
    isVisible: () => base.isVisible() && focus.get() !== false && opts.wanted(),
    onVisible(fn) {
      const offs = [
        base.onVisible(fn),
        focus.subscribe((prev, next) => { if (prev === false && next !== false) fn(); }),
        opts.onWanted(fn),
      ];
      return () => { for (const off of offs) off(); };
    },
    setInterval: (fn, ms) => base.setInterval(fn, ms),
    clearInterval: (handle) => base.clearInterval(handle),
  };
}

/**
 * The reopening edges of one boolean the hook computes per render: `set(value)`
 * fires the subscribers on false -> true only.
 */
export function createWantedEdge(initial: boolean): {
  get: () => boolean;
  set: (value: boolean) => void;
  onWanted: (fn: () => void) => () => void;
} {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const opened = !value && next;
      value = next;
      if (opened) for (const fn of [...listeners]) fn();
    },
    onWanted(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
