import { useCallback, useSyncExternalStore } from 'react';
import type { ChatMessage } from '../types';

/**
 * Which chats hold only the TAIL of their history right now, and how to get
 * the rest.
 *
 * A tail-first open (`shared/history-paging.ts`) leaves the store with the
 * last page of a conversation until the rest is merged - which happens only
 * when nobody is looking at the list, or when somebody asks. Three parties
 * must know: the transcript, which must not treat the head of the list as the
 * beginning of the chat (a compaction divider whose anchor is not loaded yet
 * would be drawn on top; a palette jump to an older message would be given up
 * as "not in this thread") and which draws the "load the older messages" row
 * on top of the loaded window; `useChat`, which is the one able to fetch and
 * merge the rest; and any surface that reads "all the messages" of a session,
 * which asks for completion through `requestHistoryCompletion` before it
 * answers.
 *
 * A module store with a per-session subscription, like `messageStore`, rather
 * than a prop threaded through six layout components: the components that ask
 * already know their session key, and the root must not re-render for it.
 *
 * FOUR STATES, not two.
 *
 *  - `unknown`: this page never loaded the session. It may hold the local copy
 *    (the last page) and nothing says whether the thread is longer. It matters
 *    to `loadHistory`, which treats a page that overlaps a session known
 *    COMPLETE as a refresh of its tail, and a page over an unknown one as the
 *    tail of a thread whose length only `total` tells.
 *  - `partial`: the store holds the tail from `boundaryId` on; `missing` rows
 *    sit before it on the server.
 *  - `staged`: those rows have ARRIVED and are held here, not in the message
 *    store. The fetch is asked for while the pane is hidden, but the answer
 *    lands 0.7-1.7 s later on a big chat, and the pane may be on screen again
 *    by then: merging on arrival would re-index the rows under the reader's
 *    eyes, which is the one thing this whole shape exists to avoid. So the
 *    rows wait here for the next hidden moment, or for a click on the row at
 *    the top, and the merge is a second, explicit step (`mode: 'apply'`).
 *  - `complete`: the store holds the whole thread.
 */

export type HistoryCompleteness =
  | { state: 'unknown' }
  | {
      state: 'partial';
      /** The oldest message the store holds: the `before` cursor of the rest. */
      boundaryId: string;
      /** How many messages the server has before the boundary. */
      missing: number;
    }
  | {
      state: 'staged';
      boundaryId: string;
      missing: number;
      /** The rows before the boundary, fetched and waiting to be merged. */
      rows: ChatMessage[];
    }
  | { state: 'complete' };

/** How a caller wants the rest: fetched and held (`stage`), or merged into the
 *  list now (`apply`, fetching first if needed). */
export type HistoryCompletionMode = 'stage' | 'apply';

const UNKNOWN: HistoryCompleteness = { state: 'unknown' };
const COMPLETE: HistoryCompleteness = { state: 'complete' };

const bySession = new Map<string, HistoryCompleteness>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionKey: string): void {
  const subs = listeners.get(sessionKey);
  if (subs) for (const fn of subs) fn();
}

function set(sessionKey: string, next: HistoryCompleteness): void {
  const prev = bySession.get(sessionKey) ?? UNKNOWN;
  if (prev === next) return;
  if (
    prev.state === 'partial' &&
    next.state === 'partial' &&
    prev.boundaryId === next.boundaryId &&
    prev.missing === next.missing
  ) return;
  if (next === UNKNOWN) bySession.delete(sessionKey);
  else bySession.set(sessionKey, next);
  notify(sessionKey);
}

/** The store holds only the last page of this session, from `boundaryId` on. */
export function markHistoryPartial(sessionKey: string, info: { boundaryId: string; missing: number }): void {
  set(sessionKey, { state: 'partial', boundaryId: info.boundaryId, missing: Math.max(0, info.missing) });
}

/**
 * The rows before the boundary have arrived and wait to be merged. Only from
 * `partial`, and only for the boundary they were asked with: an answer for a
 * boundary the store no longer has is stale and is dropped.
 */
export function markHistoryStaged(sessionKey: string, boundaryId: string, rows: ChatMessage[]): void {
  const prev = bySession.get(sessionKey);
  if (!prev || prev.state !== 'partial' || prev.boundaryId !== boundaryId) return;
  set(sessionKey, { state: 'staged', boundaryId, missing: prev.missing, rows });
}

/** The store holds the whole thread (or was emptied: nothing is missing). */
export function markHistoryComplete(sessionKey: string): void {
  set(sessionKey, COMPLETE);
}

/** The session's messages left the store: what it held says nothing anymore. */
export function resetHistoryCompleteness(sessionKey: string): void {
  set(sessionKey, UNKNOWN);
}

export function getHistoryCompleteness(sessionKey: string): HistoryCompleteness {
  return bySession.get(sessionKey) ?? UNKNOWN;
}

/** The list is still missing its head, whether the rows are on their way or waiting. */
export function isHistoryIncomplete(c: HistoryCompleteness): c is Extract<HistoryCompleteness, { state: 'partial' | 'staged' }> {
  return c.state === 'partial' || c.state === 'staged';
}

function subscribe(sessionKey: string, fn: () => void): () => void {
  let subs = listeners.get(sessionKey);
  if (!subs) {
    subs = new Set();
    listeners.set(sessionKey, subs);
  }
  subs.add(fn);
  return () => {
    const s = listeners.get(sessionKey);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(sessionKey);
  };
}

/** The completeness of this session's transcript, live. */
export function useHistoryCompleteness(sessionKey: string): HistoryCompleteness {
  const sub = useCallback((fn: () => void) => subscribe(sessionKey, fn), [sessionKey]);
  const snapshot = useCallback(() => getHistoryCompleteness(sessionKey), [sessionKey]);
  return useSyncExternalStore(sub, snapshot, snapshot);
}

/**
 * The one able to fetch and merge the rest of a thread: `useChat` registers
 * its `completeHistory` here, and every reader asks through
 * `requestHistoryCompletion` instead of receiving a prop. Returns the
 * unregister function, for the hook's teardown.
 */
type Completer = (sessionKey: string, mode: HistoryCompletionMode) => Promise<void>;
let completer: Completer | null = null;

export function registerHistoryCompleter(fn: Completer): () => void {
  completer = fn;
  return () => {
    if (completer === fn) completer = null;
  };
}

/**
 * Bring this session's transcript towards the whole thread: `stage` fetches
 * the rows and holds them, `apply` merges them into the list (fetching first
 * if they are not here yet). A no-op that resolves at once when nothing is
 * missing or nobody can fetch it (the hook is not mounted: a unit bench, a
 * page still booting). The completer dedups its own in-flight requests, so
 * calling this twice costs one fetch.
 */
export function requestHistoryCompletion(sessionKey: string, mode: HistoryCompletionMode): Promise<void> {
  if (!isHistoryIncomplete(getHistoryCompleteness(sessionKey))) return Promise.resolve();
  if (!completer) return Promise.resolve();
  return completer(sessionKey, mode);
}

/** For tests: forget every session and the completer. */
export function __resetHistoryCompleteness(): void {
  bySession.clear();
  listeners.clear();
  completer = null;
}
