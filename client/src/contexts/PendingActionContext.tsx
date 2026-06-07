/**
 * PendingActionContext — Things3-style "pending action with countdown".
 *
 * Pattern: instead of committing a soft-destructive action immediately
 * (close tab / archive topic / archive project), we register a *pending*
 * action that materialises as a toast with a checkbox. The user has to
 * tick the checkbox (active confirmation) — that starts a short progress
 * bar (default 3s); when the bar fills, the action commits. The user can
 * cancel anytime before commit (either by un-ticking, by clicking the
 * Cancel button, or by dismissing the toast).
 *
 * Invariants:
 *  - At most one pending action *for the same key* is queued. Re-registering
 *    the same key replaces the prior pending entry (the user re-clicked
 *    "close tab" on a tab that was already pending).
 *  - The bypass-on-direct-confirm path (right-click → "Close now" /
 *    "Archive now") does NOT go through this context — those callsites
 *    invoke the underlying commit fn directly.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type PendingActionKind =
  | 'close-tab'
  | 'archive-topic'
  | 'archive-project'
  | 'close-terminal'
  | 'close-browser';

export interface PendingAction {
  /** Stable de-dupe key. Same key replaces any prior pending entry. */
  key: string;
  /** Drives the icon and label phrasing. */
  kind: PendingActionKind;
  /** Short human label, e.g. the tab title or topic name. */
  label: string;
  /** Optional accent color (hex) for the toast icon — propagated from topic. */
  color?: string;
  /** Function that performs the actual mutation when the countdown ends. */
  commit: () => void | Promise<void>;
  /** Optional pre-tick cancel hook (e.g. log analytics). Always called when
   *  the user dismisses without committing. */
  onCancel?: () => void;
}

export interface PendingActionEntry extends PendingAction {
  /** wall-clock ms when registered. Used as a tiebreaker / age in UI. */
  createdAt: number;
  /** wall-clock ms when the user ticked the checkbox; null while pending tick. */
  tickedAt: number | null;
}

interface PendingActionContextValue {
  entries: PendingActionEntry[];
  /** Register a new pending action (or replace one with the same key). */
  enqueue: (action: PendingAction) => void;
  /** User ticked the checkbox — starts the countdown. */
  tick: (key: string) => void;
  /** User un-ticked or clicked Cancel. */
  cancel: (key: string) => void;
  /** Internal: timer fired → commit and pop. */
  __completeForCommit: (key: string) => void;
  /** Configurable countdown duration (ms). Default 3000. */
  countdownMs: number;
}

const Ctx = createContext<PendingActionContextValue | null>(null);

export interface PendingActionProviderProps {
  children: ReactNode;
  /** Countdown duration in ms after the user ticks. Default 3000. */
  countdownMs?: number;
}

export function PendingActionProvider({
  children,
  countdownMs = 3000,
}: PendingActionProviderProps) {
  const [entries, setEntries] = useState<PendingActionEntry[]>([]);
  // Per-key commit timers so cancels are cheap (no need to scan).
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((key: string) => {
    const t = timers.current.get(key);
    if (t) {
      clearTimeout(t);
      timers.current.delete(key);
    }
  }, []);

  const enqueue = useCallback((action: PendingAction) => {
    clearTimer(action.key);
    setEntries((prev) => {
      const filtered = prev.filter((e) => e.key !== action.key);
      return [
        ...filtered,
        { ...action, createdAt: Date.now(), tickedAt: null },
      ];
    });
  }, [clearTimer]);

  const cancel = useCallback((key: string) => {
    clearTimer(key);
    setEntries((prev) => {
      const entry = prev.find((e) => e.key === key);
      if (entry?.onCancel) {
        try {
          entry.onCancel();
        } catch {
          /* user-supplied — never throw out */
        }
      }
      return prev.filter((e) => e.key !== key);
    });
  }, [clearTimer]);

  const __completeForCommit = useCallback((key: string) => {
    clearTimer(key);
    let committed: PendingActionEntry | undefined;
    setEntries((prev) => {
      committed = prev.find((e) => e.key === key);
      return prev.filter((e) => e.key !== key);
    });
    if (committed) {
      // Run async commit outside the render cycle.
      Promise.resolve()
        .then(() => committed!.commit())
        .catch((err) => {
          // Soft-destructive — never crash the app on commit failure.
          console.warn('[PendingAction] commit failed:', err);
        });
    }
  }, [clearTimer]);

  const tick = useCallback((key: string) => {
    setEntries((prev) =>
      prev.map((e) => (e.key === key ? { ...e, tickedAt: Date.now() } : e)),
    );
    // Schedule the commit. Using a stable per-key timer so a re-tick after a
    // cancel just reschedules cleanly.
    clearTimer(key);
    const t = setTimeout(() => {
      __completeForCommit(key);
    }, countdownMs);
    timers.current.set(key, t);
  }, [clearTimer, __completeForCommit, countdownMs]);

  // Cleanup all timers on unmount (and only on unmount — avoid React 18
  // strict-mode double-invoke wiping live timers, which would silently
  // un-schedule an in-flight commit).
  useEffect(() => {
    const owned = timers.current;
    return () => {
      for (const t of owned.values()) clearTimeout(t);
      owned.clear();
    };
  }, []);

  // Wire the module-singleton imperative API to this provider's dispatchers.
  // Last-mount-wins (only one provider expected, but if multiple are nested
  // for some reason the innermost should be authoritative for the whole tree).
  useEffect(() => {
    apiSingleton = { enqueue, cancel, tick };
    return () => {
      if (apiSingleton && apiSingleton.enqueue === enqueue) apiSingleton = null;
    };
  }, [enqueue, cancel, tick]);

  const value = useMemo<PendingActionContextValue>(
    () => ({ entries, enqueue, tick, cancel, __completeForCommit, countdownMs }),
    [entries, enqueue, tick, cancel, __completeForCommit, countdownMs],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function usePendingActions(): PendingActionContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      'usePendingActions must be used inside <PendingActionProvider>',
    );
  }
  return ctx;
}

/** Returns the live status of a pending action by key, or null if no entry
 *  is queued. UI components use this to render an inline check + countdown
 *  ring in place of the original X / archive icon. The callsite typically:
 *    - clicks the icon → calls enqueueAndTick on App-level (status appears)
 *    - re-clicks the icon → calls `cancel()` returned here (status clears)
 *  The `tickedAt` timestamp lets the renderer animate a progress ring with
 *  CSS transitions (e.g. stroke-dashoffset over `countdownMs`). */
export interface PendingActionStatus {
  entry: PendingActionEntry;
  countdownMs: number;
  cancel: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function usePendingActionStatus(key: string | null | undefined): PendingActionStatus | null {
  const { entries, cancel, countdownMs } = usePendingActions();
  if (!key) return null;
  const entry = entries.find((e) => e.key === key);
  if (!entry) return null;
  return { entry, countdownMs, cancel: () => cancel(key) };
}

// ─── Sidebar ↔ Topbar synchronization helpers ─────────────────────────────
//
// The Things3-pattern enqueues a pending action under a kind-specific key
// (`archive-topic:`, `close-terminal:`, `close-browser:`, `close-tab:`).
// The SAME underlying entity can be targeted from two places:
//
//   - Topic close: sidebar TopicItem registers `archive-topic:<id>` /
//                  topbar PaneTabBar registers `close-tab:chat:<id>`
//   - Terminal:    sidebar terminal row registers `close-terminal:<id>` /
//                  topbar PaneTabBar registers `close-tab:terminal:<id>`
//   - Browser:     sidebar browser row registers `close-browser:<id>` /
//                  topbar PaneTabBar registers `close-tab:browser:<id>`
//
// Without the helpers below, a countdown started in one surface is
// invisible in the other — the user gets inconsistent visual feedback.
// Each helper returns the first matching pending entry across the
// surface-specific key set, so BOTH surfaces show the same countdown
// regardless of where it was triggered.

/**
 * Returns the pending countdown affecting this topic, whether triggered
 * from the sidebar archive icon or the topbar close-tab. The sidebar
 * TopicItem uses this so a topbar-initiated close also shows the row
 * progress overlay.
 */
// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function useTopicPendingStatus(
  topicId: string,
  options: { isArchived?: boolean } = {},
): PendingActionStatus | null {
  const { entries, cancel, countdownMs } = usePendingActions();
  const candidates: string[] = [];
  // Sidebar archive comes first — it's the more user-deliberate action
  // and carries the topic-level intent (close-tab only kills the open
  // pane, archive removes the topic from the listing).
  if (!options.isArchived) candidates.push(`archive-topic:${topicId}`);
  candidates.push(`close-tab:chat:${topicId}`);
  for (const key of candidates) {
    const entry = entries.find((e) => e.key === key);
    if (entry) return { entry, countdownMs, cancel: () => cancel(key) };
  }
  return null;
}

/**
 * Returns the pending countdown affecting this terminal session, whether
 * triggered from the sidebar terminal row or the topbar tab close.
 */
// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function useTerminalPendingStatus(sessionId: string): PendingActionStatus | null {
  const { entries, cancel, countdownMs } = usePendingActions();
  const candidates = [
    `close-terminal:${sessionId}`,
    `close-tab:terminal:${sessionId}`,
  ];
  for (const key of candidates) {
    const entry = entries.find((e) => e.key === key);
    if (entry) return { entry, countdownMs, cancel: () => cancel(key) };
  }
  return null;
}

/**
 * Returns the pending countdown affecting this browser context, whether
 * triggered from the sidebar browser row or the topbar tab close.
 */
// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function useBrowserPendingStatus(contextId: string): PendingActionStatus | null {
  const { entries, cancel, countdownMs } = usePendingActions();
  const candidates = [
    `close-browser:${contextId}`,
    `close-tab:browser:${contextId}`,
  ];
  for (const key of candidates) {
    const entry = entries.find((e) => e.key === key);
    if (entry) return { entry, countdownMs, cancel: () => cancel(key) };
  }
  return null;
}

/**
 * Returns the pending countdown affecting this pane. Used by the topbar
 * PaneTabBar. For chat/terminal/browser panes, also checks the sidebar-
 * side key so the topbar tab shows the same countdown when the close was
 * triggered from the sidebar.
 *
 * Pane id format (from `client/src/state/pane/adapters/paneConfig.ts`):
 *   - `chat:<topicId>`
 *   - `terminal:<sessionId>`
 *   - `browser:<contextId>`
 *   - `project:<encodedPath>`, `session-viewer:<sessionKey>`, etc.
 */
// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function usePanePendingStatus(paneId: string | null | undefined): PendingActionStatus | null {
  const { entries, cancel, countdownMs } = usePendingActions();
  if (!paneId) return null;
  const candidates: string[] = [`close-tab:${paneId}`];
  if (paneId.startsWith('chat:')) {
    candidates.push(`archive-topic:${paneId.slice('chat:'.length)}`);
  } else if (paneId.startsWith('terminal:')) {
    candidates.push(`close-terminal:${paneId.slice('terminal:'.length)}`);
  } else if (paneId.startsWith('browser:')) {
    candidates.push(`close-browser:${paneId.slice('browser:'.length)}`);
  }
  for (const key of candidates) {
    const entry = entries.find((e) => e.key === key);
    if (entry) return { entry, countdownMs, cancel: () => cancel(key) };
  }
  return null;
}

// ─── Module-singleton imperative API ──────────────────────────────────────
//
// Mirror of the UndoContext pattern: exposes `enqueuePendingAction()` etc. as
// plain function calls so non-React-tree callers (custom hooks composed
// outside the provider, module-level utilities, keyboard handlers) can
// register pending actions without lifting their entire call chain into a
// React component. The provider wires its dispatchers into this singleton
// on mount and unwires on unmount — calls before the provider mounts are
// silent no-ops with a console warn so the bug is visible without crashing.

interface PendingActionApi {
  enqueue: (action: PendingAction) => void;
  cancel: (key: string) => void;
  tick: (key: string) => void;
}

let apiSingleton: PendingActionApi | null = null;

function withApi<K extends keyof PendingActionApi>(
  fnName: K,
): PendingActionApi[K] {
  return ((...args: Parameters<PendingActionApi[K]>) => {
    if (!apiSingleton) {
      console.warn(
        `[PendingAction] ${fnName} called before <PendingActionProvider> mounted; ignoring.`,
      );
      return;
    }
    // @ts-expect-error tuple spread on union — runtime is correct.
    return apiSingleton[fnName](...args);
  }) as PendingActionApi[K];
}

/** Imperative: register a pending action. Mirrors `enqueue` from the hook. */
// eslint-disable-next-line react-refresh/only-export-components -- imperative API bound to the module-private singleton wired by the Provider above; cannot live in a separate file
export const enqueuePendingAction = withApi('enqueue');
/** Imperative: programmatically tick (rarely needed; usually the user does it). */
// eslint-disable-next-line react-refresh/only-export-components -- imperative API bound to the module-private singleton wired by the Provider above; cannot live in a separate file
export const tickPendingAction = withApi('tick');
