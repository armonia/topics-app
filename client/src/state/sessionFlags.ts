import { useCallback, useSyncExternalStore } from 'react';

/**
 * The per-session turn flags of the chat (loading, streaming, thinking, stopped
 * by the user), outside `App`'s state.
 *
 * THE PROBLEM. `useChat` is called by `App`, and these four maps were its
 * `useState`: a `stream:start` for a topic nobody is looking at re-rendered the
 * whole tree, sidebar, tab bars and every pane, to flip one boolean. Measured
 * on a copy of a real workspace (client-speed audit, 30/09): one background
 * `stream:start` plus one chunk cost 8 React commits and 1026 component renders.
 * The messages had already moved out for the same reason (`messageStore.ts`);
 * the flags had not.
 *
 * THE SHAPE. Same as the message store: a module store with a subscription PER
 * SESSION. A pane subscribes to its own session key and wakes up for it alone;
 * `App` does not subscribe, so a background turn no longer reaches it.
 *
 * `update()` takes the same updater as `useState` (`prev => next` over the whole
 * map), so the thirty call sites in `useChat` read exactly as before.
 *
 * Only a change of a session's BOOLEAN wakes its subscribers: `{...prev, [sk]:
 * false}` over an absent key is a new map with nothing new in it, and waking
 * the pane for it would re-render it for nothing.
 */

export type SessionFlag = 'loading' | 'streaming' | 'thinking' | 'stopped';
export type FlagMap = Record<string, boolean>;

let maps: Record<SessionFlag, FlagMap> = { loading: {}, streaming: {}, thinking: {}, stopped: {} };
const perSession = new Map<string, Set<() => void>>();
const everyone = new Set<() => void>();

/** One flag of one session. */
export function getSessionFlag(flag: SessionFlag, sessionKey: string): boolean {
  return maps[flag][sessionKey] === true;
}

/**
 * Replace one flag's map. Wakes the subscribers of every session whose boolean
 * changed, and the global ones if any did.
 */
export function updateSessionFlags(flag: SessionFlag, updater: FlagMap | ((prev: FlagMap) => FlagMap)): void {
  const prev = maps[flag];
  const next = typeof updater === 'function' ? updater(prev) : updater;
  if (next === prev) return;
  maps = { ...maps, [flag]: next };
  const changed: string[] = [];
  for (const k of Object.keys(next)) if ((prev[k] === true) !== (next[k] === true)) changed.push(k);
  for (const k of Object.keys(prev)) if (!(k in next) && prev[k] === true) changed.push(k);
  if (changed.length === 0) return;
  for (const k of changed) {
    const subs = perSession.get(k);
    if (subs) for (const fn of [...subs]) fn();
  }
  for (const fn of [...everyone]) fn();
}

/** A `useState`-style setter bound to one flag: stable for the life of the module. */
export function flagSetter(flag: SessionFlag): (updater: FlagMap | ((prev: FlagMap) => FlagMap)) => void {
  return (updater) => updateSessionFlags(flag, updater);
}

/** A read-only ref whose `current` is always the store's live map of `flag`. */
export function flagMapRef(flag: SessionFlag): { readonly current: FlagMap } {
  return {
    get current() {
      return maps[flag];
    },
  };
}

/** Subscribe to the flags of ONE session: the reason this store exists. */
export function subscribeSessionFlags(sessionKey: string, fn: () => void): () => void {
  let subs = perSession.get(sessionKey);
  if (!subs) {
    subs = new Set();
    perSession.set(sessionKey, subs);
  }
  subs.add(fn);
  return () => {
    const s = perSession.get(sessionKey);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) perSession.delete(sessionKey);
  };
}

/** Subscribe to any change of any session. For the few that summarise all of them. */
export function subscribeAllSessionFlags(fn: () => void): () => void {
  everyone.add(fn);
  return () => {
    everyone.delete(fn);
  };
}

/**
 * One boolean of one session, re-rendering only when THAT session's flags change.
 * `read` is the getter the component was handed (`isSessionStreaming`...): the
 * store says when to look, the getter says what to see.
 */
export function useSessionFlagValue(sessionKey: string, read: (sessionKey: string) => boolean): boolean {
  const subscribe = useCallback((onChange: () => void) => subscribeSessionFlags(sessionKey, onChange), [sessionKey]);
  const snapshot = useCallback(() => read(sessionKey), [sessionKey, read]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Tests only: back to the boot state. */
export function __resetSessionFlags(): void {
  maps = { loading: {}, streaming: {}, thinking: {}, stopped: {} };
  perSession.clear();
  everyone.clear();
}
