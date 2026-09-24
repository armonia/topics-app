/**
 * The unsent messages, split between the two places that show them.
 *
 * Reported on 24/09: the "1 messaggio non inviato" toast floated `absolute` allow-italian: quotes the UI text that was reported
 * over the grid, so with several columns it landed on the pane under the
 * middle of the screen (whatever chat the message belonged to), on top of that
 * pane's composer, and partly cut. A message belongs to ONE chat, so it is
 * shown there: `UnsentStrip` sits above the composer of the chat it belongs
 * to, in flow like the other strips. What is left, messages of chats that are
 * not on screen, goes to `UnsentBanner`, a band in flow that covers no pane:
 * at the foot of the grid on the desktop, in the alarm band above the bottom
 * bar on the phone.
 *
 * The split needs one fact nobody had: WHICH chats are on screen right now.
 * A strip that actually renders (its pane has a box) claims its session here,
 * and the band leaves those sessions out. Claiming from the strip itself, and
 * not from a list of open tabs, is deliberate: a chat mounted somewhere without
 * the strip claims nothing, so its messages fall back to the band instead of
 * disappearing.
 */
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

export interface UnsentItem {
  sessionKey: string;
  content: string;
  timestamp: string;
}

export interface UnsentContextValue {
  /** The whole queue, in order. */
  messages: readonly UnsentItem[];
  /** The same queue by session, in first-seen order. */
  bySession: ReadonlyMap<string, readonly UnsentItem[]>;
  retrySession: (sessionKey: string) => void;
  dismissSession: (sessionKey: string) => void;
  /**
   * The grid is on the page but something opaque covers it: the phone's
   * drawer, which is its home screen. A chat behind it has a box and is not
   * seen, so its strip must not take its messages away from the band.
   */
  gridCovered: boolean;
}

const EMPTY: UnsentContextValue = {
  gridCovered: false,
  messages: [],
  bySession: new Map(),
  retrySession: () => {},
  dismissSession: () => {},
};

/** Provided by `App`. Outside it nothing is unsent, and nothing renders. */
export const UnsentContext = createContext<UnsentContextValue>(EMPTY);

export function useUnsent(): UnsentContextValue {
  return useContext(UnsentContext);
}

/**
 * The context value for a queue. It changes only when the queue (or what the
 * callbacks close over) does: every open chat reads this context, and a value
 * rebuilt on each render of `App` would re-render them all. `retry` and
 * `dismiss` are stable callbacks in `useChat`, so in practice that is the queue.
 */
export function useUnsentController<T extends UnsentItem>(
  queue: readonly T[] | undefined,
  retry: ((item: T) => void) | undefined,
  dismiss: ((sessionKey: string) => void) | undefined,
  gridCovered = false,
): UnsentContextValue {
  return useMemo<UnsentContextValue>(() => {
    const messages = queue ?? [];
    return {
      gridCovered,
      messages,
      bySession: groupBySession(messages),
      retrySession: (sessionKey) => {
        messages.filter((m) => m.sessionKey === sessionKey).forEach((m) => retry?.(m));
      },
      dismissSession: (sessionKey) => dismiss?.(sessionKey),
    };
  }, [queue, retry, dismiss, gridCovered]);
}

export function useUnsentFor(sessionKey: string): {
  items: readonly UnsentItem[];
  gridCovered: boolean;
  retry: () => void;
  dismiss: () => void;
} | null {
  const ctx = useContext(UnsentContext);
  const items = ctx.bySession.get(sessionKey);
  if (!items || items.length === 0) return null;
  return {
    items,
    gridCovered: ctx.gridCovered,
    retry: () => ctx.retrySession(sessionKey),
    dismiss: () => ctx.dismissSession(sessionKey),
  };
}

/** Group a flat queue by session, keeping first-seen order. */
export function groupBySession<T extends { sessionKey: string }>(items: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(item.sessionKey);
    if (list) list.push(item);
    else out.set(item.sessionKey, [item]);
  }
  return out;
}

/**
 * Open (or focus) a chat from the band. Same funnel as a notification click:
 * usePanelLifecycle's `topics:open-topic` listener opens the topic through
 * openPanel, which routes a project topic to its project pane (switching
 * project) instead of leaving a ghost tab behind, and closes the phone drawer.
 */
export function openUnsentChat(topicId: string): void {
  window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId, mode: 'permanent', reveal: true } }));
}

// --- Sessions whose strip is on screen ------------------------------------
// A count and not a flag: the same chat can be open in two visible panes, and
// closing one of them must not hand its messages back to the band.
const claims = new Map<string, number>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = new Set(claims.keys());
  for (const cb of listeners) cb();
}

/** Mark `sessionKey` as shown in a chat on screen. Returns the release. */
export function claimOnScreen(sessionKey: string): () => void {
  claims.set(sessionKey, (claims.get(sessionKey) ?? 0) + 1);
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (claims.get(sessionKey) ?? 1) - 1;
    if (left <= 0) claims.delete(sessionKey);
    else claims.set(sessionKey, left);
    publish();
  };
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const read = () => snapshot;

/** The same set, read outside React (tests, and any non-component caller). */
export function onScreenSessions(): ReadonlySet<string> {
  return snapshot;
}

/** The sessions whose unsent messages are already shown inside their chat. */
export function useOnScreenSessions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, read, read);
}
